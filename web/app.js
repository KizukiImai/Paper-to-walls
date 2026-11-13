import { boundsOf, distance, graphSegments, graphToLayout, layoutToGraph, normalizeGraph, validateLayout, validQuad } from './lib/geometry.js';
import { straighteningTolerance } from './lib/straighten.js';
import { DEFAULT_CONFIG } from './lib/vision-core.js';
import { History } from './lib/history.js';
import { PlanEditor } from './lib/editor.js';
import { WallPreview } from './lib/preview.js';

const $ = id => document.getElementById(id);
const EMPTY = () => ({ nodes: [], walls: [] });
const newId = () => `layout-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')}`;
const state = {
  mode: 'input', view: '2d', tool: 'select', source: null, sourceName: '', rectified: null, binary: null, skeleton: null,
  corners: [], width: 0, height: 0, graph: EMPTY(), selected: null, pixelsPerMeter: 100, origin: { x: 0, y: 0 },
  wallHeight: 2.5, wallThickness: 0.15, calibrated: false, layoutId: newId(), hasResult: false,
  paths: null, manuallyEdited: false, pendingCrop: false, dirty: false, busy: false, serverReady: false, showImage: true, showNodes: true, snapEnabled: true, diagnostic: 'none', config: { ...DEFAULT_CONFIG }
};
const history = new History(state.graph);
let worker = null, jobReject = null, jobTimer = null, preview = null, toastTimer = null;
let operationId = 0, networkBusy = false, targetChangeId = 0;
let destination = { mode:'remote', host:'', port:3001 };
try { const saved = JSON.parse(localStorage.getItem('paper-space.destination') || '{}'); if (typeof saved.host === 'string') destination.host = saved.host; if (Number.isInteger(saved.port)) destination.port=saved.port; if (['remote','local'].includes(saved.mode)) destination.mode=saved.mode; } catch { /* Optional preferences only. */ }
let lastRevision = 0;
try { lastRevision = Number(localStorage.getItem('paper-space.lastRevision')) || 0; } catch { /* Storage may be disabled; exports still work. */ }

function toast(message, error = false) {
  const element = $('toast'); element.textContent = message; element.classList.toggle('error', error); element.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { element.hidden = true; }, error ? 9000 : 5000);
}
function markDirty() { state.dirty = true; }
function available() { return state.hasResult && !state.pendingCrop && !state.busy; }
function getLayout(revision = lastRevision + 1) {
  return graphToLayout(state.graph, { pixelsPerMeter: state.pixelsPerMeter, origin: state.origin, wallHeight: state.wallHeight, wallThickness: state.wallThickness, layoutId: state.layoutId, revision });
}
function editorState() {
  const crop = state.mode === 'crop';
  const image = crop ? state.source : state.diagnostic === 'binary' ? state.binary : state.diagnostic === 'skeleton' ? state.skeleton : state.rectified;
  return { ...state, mode: crop ? 'crop' : 'edit', image, width: crop ? state.source?.width : state.width, height: crop ? state.source?.height : state.height, disabled: state.busy || (!crop && state.diagnostic !== 'none') };
}
const editor = new PlanEditor($('editorCanvas'), editorState, {
  edit(graph, commit) {
    state.graph = graph; state.manuallyEdited = true; markDirty();
    if (commit) { state.graph = normalizeGraph(graph); history.push(state.graph); if (!state.graph.walls.some(w => w.id === state.selected)) state.selected = null; }
    updateUI();
  },
  select(id) { state.selected = id; updateUI(); },
  corner(index, point) { state.corners[index] = point; state.pendingCrop = true; markDirty(); updateUI(); },
  deleteSelected, undo, redo,
  zoom(percent) { $('zoomOutput').textContent = `${percent}%`; }
});

function updateUI({ fit = false, animate = false } = {}) {
  const ready = available(), crop = state.mode === 'crop', is3D = state.view === '3d';
  document.querySelectorAll('[data-step]').forEach(button => {
    const step = button.dataset.step;
    button.classList.toggle('active', state.mode === step);
    button.disabled = state.busy || (step === 'crop' && !state.source) || (['edit', 'preview'].includes(step) && !ready);
  });
  $('emptyState').hidden = !!state.source || state.hasResult;
  $('sourcePreview').hidden = !state.source; $('sourceName').textContent = state.sourceName;
  $('cropOptions').hidden = !state.source || !crop;
  $('editTools').hidden = !ready || crop || is3D || state.diagnostic !== 'none';
  $('previewTools').hidden = !is3D || !ready;
  $('canvasCaption').hidden = !state.source && !state.hasResult;
  $('canvasCaptionText').textContent = crop ? '1・2・3・4を紙の四隅へ' : is3D ? 'ドラッグで回転・右ドラッグで移動' : state.tool === 'add' ? '始点 → 終点をクリック' : state.tool === 'delete' ? '削除する壁をクリック' : '点をドラッグして接続を編集';
  $('zoomTools').hidden = is3D || (!state.source && !state.hasResult);
  $('viewSettings').hidden = !ready || is3D || crop;
  $('editorCanvas').hidden = is3D; $('previewCanvas').hidden = !is3D;
  $('view2dButton').classList.toggle('active', !is3D); $('view3dButton').classList.toggle('active', is3D); $('view3dButton').disabled = !ready;
  $('view2dButton').disabled = state.busy;
  $('view2dButton').textContent = crop ? '用紙の補正' : '2D 編集';
  document.querySelectorAll('[data-tool]').forEach(button => button.classList.toggle('active', button.dataset.tool === state.tool));
  $('undoButton').disabled = !history.canUndo || state.busy; $('redoButton').disabled = !history.canRedo || state.busy;
  for (const id of ['downloadButton', 'showJsonButton', 'saveProjectButton']) $(id).disabled = !ready;
  $('sendButton').disabled = !ready || !state.serverReady || networkBusy;
  $('checkTargetButton').disabled = !state.serverReady || networkBusy;
  $('applyStraightenButton').disabled = !ready || !state.paths;
  for (const id of ['straightnessInput','axisAngleInput','axisSnapInput','thresholdInput','minLengthInput','gapInput','snapInput','resolutionInput','sampleSelect']) $(id).disabled = state.busy;
  document.querySelectorAll('[data-strength]').forEach(b=>b.disabled=state.busy);
  $('applyWidthButton').disabled = !ready || !state.graph.nodes.length;
  $('rerunButton').disabled = !state.source || state.busy;
  for (const id of ['uploadButton', 'cameraButton', 'sampleButton', 'emptySampleButton', 'importJsonButton', 'recognizeButton', 'autoCorners', 'fullCorners', 'rotateButton', 'newButton']) $(id).disabled = state.busy;
  $('progressOverlay').hidden = !state.busy;
  $('wallCount').textContent = state.hasResult ? String(state.graph.walls.length).padStart(2, '0') : '—';
  $('nodeCount').textContent = state.hasResult ? String(state.graph.nodes.length).padStart(2, '0') : '—';
  const bounds = boundsOf(state.graph.nodes);
  $('planSize').textContent = state.hasResult ? `${(bounds.width / state.pixelsPerMeter).toFixed(2)} × ${(bounds.height / state.pixelsPerMeter).toFixed(2)} m` : '— × — m';
  $('scaleBadge').textContent = state.calibrated ? '縮尺設定済み' : '仮スケール'; $('scaleBadge').classList.toggle('amber', !state.calibrated);
  const selected = graphSegments(state.graph).find(s => s.id === state.selected);
  $('selectedWallHint').textContent = selected ? `${selected.id} / 現在 ${(distance(selected.a, selected.b) / state.pixelsPerMeter).toFixed(2)} m` : '2D画面で基準の壁を1本選んでください。';
  $('applyReferenceButton').disabled = !selected || !ready;
  $('documentLabel').textContent = state.hasResult ? state.layoutId : state.sourceName || 'UNTITLED / 01';
  $('imageResolution').textContent = crop && state.source ? `${state.source.width} × ${state.source.height} PX` : state.hasResult ? `${state.width} × ${state.height} PX` : 'NO IMAGE';
  $('workspaceHint').textContent = crop ? '四隅の推定は候補です。内側の間取り線ではなく、用紙そのものを囲んでください。A4用紙なら縦横比も指定してください。' : ready ? '接続した点を動かすと、壁も一緒に変形します。Ctrl+Zで戻す・ホイールでズーム・右ドラッグで移動。' : '写真の取得からJSONまで、すべてこの画面で。初回はサンプルで流れを確認できます。';
  $('diagnosticSelect').querySelector('[value=binary]').disabled = !state.binary;
  $('diagnosticSelect').querySelector('[value=skeleton]').disabled = !state.skeleton;
  if (fit) editor.fit(); else editor.draw();
  if (is3D && ready) {
    try {
      if (!preview) preview = new WallPreview($('previewCanvas'), message => toast(message, true));
      preview.update(getLayout(), { fit, animate });
    } catch (error) { toast(error.message, true); }
  }
}
function syncForm() {
  $('layoutIdInput').value = state.layoutId; $('wallHeightInput').value = state.wallHeight; $('wallThicknessInput').value = state.wallThickness;
  $('showImageInput').checked = state.showImage; $('showNodesInput').checked = state.showNodes; $('editSnapInput').checked = state.snapEnabled; $('diagnosticSelect').value = state.diagnostic;
  const controls = { threshold: 'thresholdInput', minLength: 'minLengthInput', gap: 'gapInput', snap: 'snapInput', longSide: 'resolutionInput' };
  for (const [key, id] of Object.entries(controls)) $(id).value = state.config[key];
  $('straightnessInput').value = state.config.straightness; $('axisAngleInput').value=state.config.axisAngle;
  $('axisSnapInput').checked = state.config.axisSnap; syncConfig();
}
function syncConfig() {
  for (const key of ['threshold', 'minLength', 'gap', 'snap']) {
    state.config[key] = Number($(key + 'Input').value); $(key + 'Output').textContent = String(state.config[key]) + (key === 'threshold' ? '' : ' px');
  }
  state.config.axisSnap = $('axisSnapInput').checked; state.config.longSide = Number($('resolutionInput').value);
  state.config.straightness = Number($('straightnessInput').value); state.config.axisAngle=Number($('axisAngleInput').value);
  $('straightnessOutput').textContent = `${state.config.straightness} / 100`;
  $('axisAngleOutput').textContent = `${state.config.axisAngle}°`;
  const tolerance=straighteningTolerance(state.config.straightness,state.width||state.config.longSide,state.height||1);
  $('straightnessHint').textContent=`曲がりの許容幅: 約${tolerance.toFixed(1)}px（処理画像）。0でも画素ノイズの整理は行います。`;
  document.querySelectorAll('[data-strength]').forEach(b=>b.classList.toggle('active',Number(b.dataset.strength)===state.config.straightness));
}
function canvasFromImageData(image) {
  const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0); return canvas;
}
function canvasFromMask(mask, width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < mask.length; i++) { const c = mask[i] ? 20 : 255; data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = c; data[i * 4 + 3] = 255; }
  return canvasFromImageData({ data, width, height });
}
function imageData(canvas) { return canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height); }
async function decodeImage(blob, maxSide = 1600) {
  if (blob.size > 30 * 1024 * 1024) throw new Error('画像は30MB以下にしてください。');
  let image;
  try { image = await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
  catch {
    const url = URL.createObjectURL(blob);
    try { image = new Image(); image.src = url; await image.decode(); } catch { throw new Error('この画像を読み込めません。JPEG・PNG・WebPに変換してから選んでください。'); } finally { URL.revokeObjectURL(url); }
  }
  const w = image.width || image.naturalWidth, h = image.height || image.naturalHeight;
  if (!w || !h || w * h > 64e6) { image.close?.(); throw new Error('画像の解像度が大きすぎます。6400万画素以下に縮小してください。'); }
  const factor = Math.min(1, maxSide / Math.max(w, h)), canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * factor)); canvas.height = Math.max(1, Math.round(h * factor));
  const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(image, 0, 0, canvas.width, canvas.height); image.close?.();
  return canvas;
}
function setBusy(message) { state.busy = true; $('progressMessage').textContent = message; $('progressBar').value = 0; updateUI(); }
function runJob(type, payload) {
  return new Promise((resolve, reject) => {
    const id = Date.now(); worker = new Worker(new URL('./recognizer.worker.js', import.meta.url), { type: 'module' }); jobReject = reject;
    const cleanup = () => { clearTimeout(jobTimer); worker?.terminate(); worker = null; jobReject = null; };
    jobTimer = setTimeout(() => { cleanup(); reject(new Error('画像処理が45秒以内に完了しませんでした。処理解像度を900pxに下げて試してください。')); }, 45000);
    worker.onmessage = ({ data }) => {
      if (data.id !== id) return;
      if (data.type === 'progress') { $('progressMessage').textContent = data.message; $('progressBar').value = data.percent; }
      else if (data.type === 'error') { cleanup(); reject(new Error(data.message)); }
      else { cleanup(); resolve(data.result); }
    };
    worker.onerror = event => { cleanup(); reject(new Error(`画像処理を開始できませんでした。HTTPサーバー経由で開いているか確認してください。${event.message ? '\n' + event.message : ''}`)); };
    worker.postMessage({ id, type, ...payload });
  });
}
function cancelJob() {
  operationId++;
  worker?.terminate(); worker = null; clearTimeout(jobTimer);
  const reject = jobReject; jobReject = null; reject?.(new DOMException('キャンセルしました。', 'AbortError'));
  state.busy = false; updateUI(); toast('画像処理をキャンセルしました。');
}
async function importImage(blob, name, confirmReplace = true) {
  if (confirmReplace && state.dirty && state.hasResult && !confirm('現在の間取りを新しい画像に置き換えます。必要な作業は保存しましたか？')) return false;
  const operation = ++operationId;
  setBusy('写真を読み込んでいます');
  try {
    const source = await decodeImage(blob);
    if (operation !== operationId) throw new DOMException('キャンセルしました。', 'AbortError');
    state.paths=null; state.manuallyEdited=false; state.source = source; state.sourceName = name || 'camera-photo'; state.graph = EMPTY(); state.hasResult = false; state.rectified = null; state.binary = null; state.skeleton = null; state.width = 0; state.height = 0; state.selected = null;
    state.mode = 'crop'; state.view = '2d'; state.diagnostic = 'none'; state.pendingCrop = true; state.calibrated = false; state.layoutId = newId();
    state.corners = [{ x: 0, y: 0 }, { x: source.width - 1, y: 0 }, { x: source.width - 1, y: source.height - 1 }, { x: 0, y: source.height - 1 }];
    $('sourceThumb').src = source.toDataURL('image/jpeg', 0.8); $('aspectSelect').value = '0'; history.reset(state.graph); editor.pending = null; syncForm(); updateUI({ fit: true });
    const result = await runJob('estimate', { image: imageData(source) });
    if (operation !== operationId) throw new DOMException('キャンセルしました。', 'AbortError');
    state.corners = result.corners;
    markDirty(); toast(result.confidence === 'candidate' ? '用紙の四隅を推定しました。位置を確認して「線を認識する」を押してください。' : '写真を読み込みました。用紙の四隅を確認してください。');
    return true;
  } catch (error) { if (error.name !== 'AbortError') toast(error.message, true); return false; }
  finally { if (operation === operationId) { state.busy = false; updateUI({ fit: true }); } }
}
async function recognizeImage(confirmReplace = true) {
  if (!state.source || state.busy) return;
  if (!validQuad(state.corners)) { toast('四隅が交差しているか、範囲が小さすぎます。位置を確認してください。', true); return; }
  if (confirmReplace && state.hasResult && !confirm('現在の認識結果と手動編集を置き換えて再認識しますか？')) return;
  const operation = ++operationId;
  syncConfig(); setBusy('線を認識しています');
  try {
    const result = await runJob('recognize', { image: imageData(state.source), corners: state.corners, aspect: Number($('aspectSelect').value), config: { ...state.config } });
    if (operation !== operationId) throw new DOMException('キャンセルしました。', 'AbortError');
    state.rectified = canvasFromImageData(result.rectified); state.width = result.rectified.width; state.height = result.rectified.height;
    state.binary = canvasFromMask(result.binary, state.width, state.height); state.skeleton = canvasFromMask(result.skeleton, state.width, state.height);
    state.paths=result.paths; state.manuallyEdited=false; state.graph = result.graph; state.selected = null; state.hasResult = true; state.pendingCrop = false; state.mode = 'edit'; state.view = '2d'; state.diagnostic = 'none'; state.tool = 'select';
    state.origin = { x: 0, y: state.height - 1 }; state.pixelsPerMeter = Math.max(boundsOf(state.graph.nodes).width, boundsOf(state.graph.nodes).height * 0.01, 1) / 5;
    state.calibrated = false; $('widthInput').value = '5'; history.reset(state.graph); editor.pending = null; markDirty(); syncForm();
    $('straightenStatus').textContent=`直線化 ${state.config.straightness}/100 を適用済み。補正量を変えて比較できます。`;
    toast(state.graph.walls.length ? `${state.graph.walls.length}本の壁を認識しました。線を確認し、実寸の縮尺を指定してください。` : '線が見つかりませんでした。認識を調整するか、「追加」で壁を描けます。', !state.graph.walls.length);
  } catch (error) { if (error.name !== 'AbortError') toast(error.message, true); }
  finally { if (operation === operationId) { state.busy = false; updateUI({ fit: true }); } }
}
async function applyStraightening() {
  if (!available() || !state.paths) return;
  if (state.manuallyEdited && !confirm('元の認識線から補正を再計算します。手動編集は置き換わりますが、Undoで戻せます。続けますか？')) return;
  syncConfig();
  const operation=++operationId, config={...state.config};
  setBusy('手描きの揺れを直線に整理しています');
  try {
    const result=await runJob('vectorize',{paths:state.paths,width:state.width,height:state.height,config});
    if (operation!==operationId) throw new DOMException('キャンセルしました。','AbortError');
    state.graph=result.graph; state.selected=null; state.manuallyEdited=false;
    history.push(state.graph); markDirty();
    $('straightenStatus').textContent=`直線化 ${config.straightness}/100 を適用済み · ${state.graph.walls.length}線分。縮尺は保持しています。`;
    toast('補正を反映しました。写真と比較してください。Undoで前の線へ戻せます。');
  } catch(error) { if(error.name!=='AbortError') toast(error.message,true); }
  finally { if(operation===operationId) {state.busy=false;updateUI();} }
}
async function useSample() {
  try {
    const name=['room','wavy-room','wavy-line'].includes($('sampleSelect').value)?$('sampleSelect').value:'room';
    const response = await fetch(`samples/${name}.png`); if (!response.ok) throw new Error('サンプル画像を読み込めませんでした。');
    const loaded = await importImage(await response.blob(), `sample-${name}.png`); if (loaded) await recognizeImage(false);
  } catch (error) { toast(error.message, true); }
}
function deleteSelected() {
  if (!state.selected || !available()) return;
  state.graph = normalizeGraph({ nodes: state.graph.nodes, walls: state.graph.walls.filter(w => w.id !== state.selected) });
  state.selected = null; state.manuallyEdited=true; history.push(state.graph); markDirty(); updateUI();
}
function undo() { if (!available()) return; state.graph = history.undo(); state.manuallyEdited=true; $('straightenStatus').textContent='Undoで戻しました。スライダーは次に適用する設定です。'; state.selected = null; markDirty(); updateUI(); }
function redo() { if (!available()) return; state.graph = history.redo(); state.manuallyEdited=true; $('straightenStatus').textContent='Redoで復元しました。スライダーは次に適用する設定です。'; state.selected = null; markDirty(); updateUI(); }
function download(content, filename, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([content], { type })), a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function confirmEmpty() { return state.graph.walls.length > 0 || confirm('壁が0本です。このJSONをUnityへ適用すると、既存の壁をすべて消す指定になります。続行しますか？'); }
function saveLayout() {
  if (!available() || !confirmEmpty()) return;
  try {
    const layout = getLayout();
    const name = state.layoutId.replace(/[^a-zA-Z0-9_-]/g, '_') || 'floorplan';
    download(JSON.stringify(layout, null, 2) + '\n', `${name}-r${layout.revision}.json`);
    lastRevision = layout.revision; try { localStorage.setItem('paper-space.lastRevision', String(lastRevision)); } catch { /* File saving is independent of browser storage. */ }
    toast('JSONを保存しました。Unityでは (ax, ay) を (X, Z) として読み込みます。');
  } catch (error) { toast(error.message, true); }
}
function readDestination() {
  const host=$('targetHostInput').value.trim(), port=Number($('targetPortInput').value);
  const parts=host.split('.');
  if(parts.length!==4 || parts.some(p=>!/^\d{1,3}$/.test(p)||Number(p)>255||String(Number(p))!==p)) throw new Error('受信PCのIPv4アドレスを入力してください（例: 192.168.1.50）。');
  if(!Number.isInteger(port)||port<1||port>65535) throw new Error('ポートは1〜65535の整数にしてください。');
  return {host,port,key:$('targetKeyInput').value};
}
function updateDestination() {
  destination={mode:$('destinationMode').value,host:$('targetHostInput').value.trim(),port:Number($('targetPortInput').value)};
  try {localStorage.setItem('paper-space.destination',JSON.stringify(destination));} catch { /* Optional settings only. */ }
  $('remoteFields').hidden=destination.mode!=='remote';
  $('sendButton').textContent=destination.mode==='remote'?'指定PCへJSONを送信 ↗':'このサーバーに保存 ↗';
  $('targetEndpoint').textContent=destination.host?`http://${destination.host}:${destination.port}/api/layouts`:'送信先IPを入力してください';
  $('targetStatus').textContent='未確認'; $('targetStatus').className='target-status'; targetChangeId++;
}
async function targetRequest(route, body) {
  const response=await fetch(route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(12000)});
  let result;
  try {result=await response.json();} catch {throw new Error('Webサーバーから正しい応答を取得できません。新しい版のサーバーで起動し直してください。');}
  if(!response.ok) throw new Error(result.error||`HTTP ${response.status}`);
  return result;
}
async function checkTarget() {
  if(networkBusy) return;
  let target; try {target=readDestination();} catch(error) {toast(error.message,true);return;}
  networkBusy=true; updateUI(); const current=targetChangeId;
  $('targetStatus').textContent='受信PCに接続しています…'; $('targetStatus').className='target-status';
  try {
    const result=await targetRequest('api/targets/check',{target});
    if(current!==targetChangeId) return;
    $('targetStatus').textContent=`受信サーバーに接続 / r${result.revision}${result.authRequired?' · 受信キーは送信時に検証':''}（Unityの表示は未確認）`;
    $('targetStatus').className='target-status success';
  } catch(error) {if(current===targetChangeId) {$('targetStatus').textContent=error.message;$('targetStatus').className='target-status error';}}
  finally {networkBusy=false;updateUI();}
}
async function sendLayout() {
  if (!available() || networkBusy || !confirmEmpty()) return;
  const remote=$('destinationMode').value==='remote';
  let target; try {if(remote) target=readDestination();} catch(error) {toast(error.message,true);return;}
  networkBusy=true; updateUI(); const current=targetChangeId;
  try {
    const body=getLayout();delete body.revision;
    const result=await targetRequest(remote?'api/targets/send':'api/layouts',remote?{target,layout:body}:body);
    const message=remote?`${target.host}:${target.port} に保存しました（r${result.revision}）。Unity側の表示も確認してください。`:`このサーバーに保存しました（r${result.revision}）。`;
    toast(message);
    if(remote&&current===targetChangeId) {$('targetStatus').textContent=`受信PCに保存済み / r${result.revision} · ${result.wallCount}線分（Unityの表示は未確認）`;$('targetStatus').className='target-status success';}
    await checkServer();
  } catch(error) {toast(`送信できませんでした。受信先に保存済みの可能性もあるため、再送前に最新JSONを確認してください。\n${error.message}`,true);
    if(remote&&current===targetChangeId) {$('targetStatus').textContent=error.message;$('targetStatus').className='target-status error';}}
  finally {networkBusy=false;updateUI();}
}
async function checkServer() {
  try {
    const response=await fetch('api/health',{signal:AbortSignal.timeout(3000)});const result=await response.json(); state.serverReady=response.ok&&result.ok;
    $('serverStatus').textContent=state.serverReady?`Webサーバー接続 / v${result.version}${result.allowForward===false?'（受信専用）':''}`:'Webサーバー未接続';
  } catch {state.serverReady=false;$('serverStatus').textContent='Webサーバー未接続 / JSON保存可';}
  $('serverDot').classList.toggle('pending',!state.serverReady);
  $('sendButton').disabled=!available()||!state.serverReady||networkBusy;
  $('checkTargetButton').disabled=!state.serverReady||networkBusy;
}
function saveProject() {
  if (!available()) return;
  try {
    getLayout();
    const project = {
      projectVersion: 1, sourceName: state.sourceName,
      sourceImage: state.source?.toDataURL('image/png') ?? null, rectifiedImage: state.rectified?.toDataURL('image/png') ?? null,
      corners: state.corners, aspect: Number($('aspectSelect').value), width: state.width, height: state.height,
      graph: state.graph, config: state.config, recognitionPaths: state.paths,
      settings: { layoutId: state.layoutId, pixelsPerMeter: state.pixelsPerMeter, origin: state.origin, wallHeight: state.wallHeight, wallThickness: state.wallThickness, calibrated: state.calibrated }
    };
    download(JSON.stringify(project), `${state.layoutId.replace(/[^a-zA-Z0-9_-]/g, '_')}.paper-space.json`);
    state.dirty = false; toast('編集用の作業ファイルを保存しました。Unityには壁のJSONを渡してください。');
  } catch (error) { toast(error.message, true); }
}
async function loadProject(project, operation) {
  const { graph, settings, width, height } = project;
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.walls) || graph.nodes.length > 3000 || graph.walls.length > 1000) throw new Error('作業ファイルのグラフ形式が不正です。');
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 2000 || height > 2000) throw new Error('作業ファイルの画像サイズが不正です。');
  if (!settings || !settings.origin || !Number.isFinite(settings.origin.x) || !Number.isFinite(settings.origin.y)) throw new Error('作業ファイルの座標原点が不正です。');
  const nodeIds = new Set();
  for (const n of graph.nodes) {
    if (typeof n.id !== 'string' || !n.id || nodeIds.has(n.id) || !Number.isFinite(n.x) || !Number.isFinite(n.y) || n.x < -1 || n.y < -1 || n.x > width || n.y > height) throw new Error('作業ファイルの接続点が不正です。');
    nodeIds.add(n.id);
  }
  if (graph.walls.some(w => !nodeIds.has(w.a) || !nodeIds.has(w.b) || typeof w.id !== 'string')) throw new Error('作業ファイルの壁参照が不正です。');
  graphToLayout(graph, { ...settings, revision: 1 });
  const decode = async value => {
    if (!value) return null;
    if (typeof value !== 'string' || !/^data:image\/(png|jpeg|webp);base64,/.test(value)) throw new Error('作業ファイルの埋め込み画像が不正です。');
    const response = await fetch(value); return decodeImage(await response.blob(), 2000);
  };
  const source = await decode(project.sourceImage), rectified = await decode(project.rectifiedImage);
  if (rectified && (rectified.width !== width || rectified.height !== height)) throw new Error('補正画像と座標のサイズが一致しません。');
  const corners = project.corners || [];
  if (source && (!validQuad(corners) || corners.some(p => p.x < 0 || p.y < 0 || p.x >= source.width || p.y >= source.height))) throw new Error('作業ファイルの四隅が不正です。');
  if (operation !== operationId) throw new DOMException('キャンセルしました。', 'AbortError');
  Object.assign(state, { source, rectified, width, height, graph, ...settings, corners, sourceName: String(project.sourceName || 'saved-project'), binary: null, skeleton: null });
  // Limit recognition settings to the same range accepted by the UI; never trust imported computation limits.
  state.config = { ...DEFAULT_CONFIG };
  const limits = { threshold: [3, 35], minLength: [5, 70], gap: [0, 20], snap: [0, 15], straightness:[0,100], axisAngle:[0,12] };
  for (const [key, [min, max]] of Object.entries(limits)) if (Number.isFinite(project.config?.[key])) state.config[key] = Math.max(min, Math.min(max, project.config[key]));
  if ([900, 1200, 1600].includes(project.config?.longSide)) state.config.longSide = project.config.longSide;
  if (typeof project.config?.axisSnap === 'boolean') state.config.axisSnap = project.config.axisSnap;
  state.paths=null; state.manuallyEdited=true;
  const paths=project.recognitionPaths;
  if(Array.isArray(paths)&&paths.length<=10000) {
    let count=0;
    const valid=paths.every(line=>Array.isArray(line)&&line.length>=2&&line.every(p=>{count++;return count<=300000&&p&&Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>=0&&p.y>=0&&p.x<width&&p.y<height;}));
    if(valid) state.paths=paths;
  }
  const aspect = Number(project.aspect); $('aspectSelect').value = [...$('aspectSelect').options].find(o => Math.abs(Number(o.value) - aspect) < 0.0001)?.value || '0';
  if (source) $('sourceThumb').src = source.toDataURL('image/jpeg', 0.8);
}
async function importJson(file) {
  if (state.dirty && state.hasResult && !confirm('現在の間取りを置き換えて開きますか？')) return;
  if (file.size > 30 * 1024 * 1024) { toast('ファイルは30MB以下にしてください。', true); return; }
  const operation = ++operationId;
  setBusy('JSONを読み込んでいます');
  try {
    const value = JSON.parse(await file.text());
    if (operation !== operationId) throw new DOMException('キャンセルしました。', 'AbortError');
    if (value.projectVersion === 1) await loadProject(value, operation);
    else {
      const errors = validateLayout(value); if (errors.length) throw new Error(errors.join('\n'));
      const converted = layoutToGraph(value);
      Object.assign(state, converted, { wallHeight: value.wallHeight, wallThickness: value.wallThickness, layoutId: value.layoutId, calibrated: true, paths:null, manuallyEdited:false, source: null, rectified: null, binary: null, skeleton: null, sourceName: file.name, corners: [] });
    }
    state.mode = 'edit'; state.view = '2d'; state.hasResult = true; state.pendingCrop = false; state.selected = null; state.diagnostic = 'none'; state.tool = 'select'; state.dirty = false;
    history.reset(state.graph); editor.pending = null; syncForm(); $('widthInput').value = (boundsOf(state.graph.nodes).width / state.pixelsPerMeter).toFixed(2);
    $('straightenStatus').textContent=state.paths?'作業を復元しました。元の認識線から補正を再計算できます。':'写真の認識情報がありません。再補正には写真を読み込んでください。';
    toast(value.projectVersion ? '作業ファイルを開きました。' : '壁のJSONを読み込みました。2D編集・3D確認ができます。');
  } catch (error) { if (error.name !== 'AbortError') toast(`ファイルを開けませんでした。\n${error.message}`, true); }
  finally { if (operation === operationId) { state.busy = false; updateUI({ fit: true }); } }
}

$('uploadButton').onclick = () => $('imageInput').click(); $('cameraButton').onclick = () => $('cameraInput').click();
for (const id of ['imageInput', 'cameraInput']) $(id).onchange = async event => { const file = event.target.files?.[0]; if (file) await importImage(file, file.name); event.target.value = ''; };
$('importJsonButton').onclick = () => $('jsonInput').click(); $('jsonInput').onchange = async event => { const file = event.target.files?.[0]; if (file) await importJson(file); event.target.value = ''; };
$('sampleButton').onclick = useSample; $('emptySampleButton').onclick = useSample;
$('recognizeButton').onclick = () => recognizeImage(); $('rerunButton').onclick = () => recognizeImage(); $('cancelButton').onclick = cancelJob;
$('autoCorners').onclick = async () => {
  if (!state.source || state.busy) return; setBusy('用紙の四隅を推定しています');
  try { const result = await runJob('estimate', { image: imageData(state.source) }); state.corners = result.corners; state.pendingCrop = true; markDirty(); toast('推定した四隅を確認してください。'); }
  catch (error) { if (error.name !== 'AbortError') toast(error.message, true); }
  finally { state.busy = false; updateUI(); }
};
$('fullCorners').onclick = () => { if (!state.source) return; const { width: w, height: h } = state.source; state.corners = [{ x: 0, y: 0 }, { x: w - 1, y: 0 }, { x: w - 1, y: h - 1 }, { x: 0, y: h - 1 }]; state.pendingCrop = true; markDirty(); updateUI(); };
$('rotateButton').onclick = () => {
  if (!state.source) return;
  const c = document.createElement('canvas'); c.width = state.source.height; c.height = state.source.width;
  const context = c.getContext('2d'); context.translate(c.width, 0); context.rotate(Math.PI / 2); context.drawImage(state.source, 0, 0);
  state.source = c; $('sourceThumb').src = c.toDataURL('image/jpeg', 0.8); $('fullCorners').click(); editor.fit();
};
$('aspectSelect').onchange = () => { state.pendingCrop = true; markDirty(); updateUI(); };
for (const id of ['thresholdInput', 'minLengthInput', 'gapInput', 'snapInput', 'resolutionInput']) $(id).addEventListener('input', syncConfig);

function correctionChanged() {syncConfig();markDirty();$('straightenStatus').textContent=state.paths?'未反映です。「補正を反映する」で元の認識線から再計算します。':'次の画像認識に適用します。';}
for(const id of ['straightnessInput','axisAngleInput','axisSnapInput']) $(id).addEventListener('input',correctionChanged);
document.querySelectorAll('[data-strength]').forEach(b=>b.onclick=()=>{$('straightnessInput').value=b.dataset.strength;correctionChanged();});
$('applyStraightenButton').onclick=applyStraightening;
for(const id of ['targetHostInput','targetPortInput','destinationMode','targetKeyInput']) $(id).addEventListener('input',updateDestination);
$('checkTargetButton').onclick=checkTarget;

document.querySelectorAll('[data-step]').forEach(button => button.onclick = () => {
  const step = button.dataset.step;
  if (step === 'input') { $('imageInput').click(); return; }
  state.mode = step; state.view = step === 'preview' ? '3d' : '2d'; editor.pending = null; updateUI({ fit: true, animate: step === 'preview' });
});
$('view2dButton').onclick = () => { state.mode = state.pendingCrop || !state.hasResult ? (state.source ? 'crop' : 'input') : 'edit'; state.view = '2d'; updateUI({ fit: true }); };
$('view3dButton').onclick = () => { if (!available()) return; state.mode = 'preview'; state.view = '3d'; updateUI({ fit: true, animate: true }); };
document.querySelectorAll('[data-tool]').forEach(button => button.onclick = () => { state.tool = button.dataset.tool; editor.pending = null; updateUI(); });
$('undoButton').onclick = undo; $('redoButton').onclick = redo;
$('fitButton').onclick = () => state.view === '3d' ? preview?.fit() : editor.fit();
$('zoomInButton').onclick = () => editor.zoomAt(1.2); $('zoomOutButton').onclick = () => editor.zoomAt(1 / 1.2);
$('topViewButton').onclick = () => preview?.top(); $('animateButton').onclick = () => preview?.animate();
for (const [id, key] of [['showImageInput', 'showImage'], ['showNodesInput', 'showNodes'], ['editSnapInput', 'snapEnabled']]) $(id).onchange = () => { state[key] = $(id).checked; updateUI(); };
$('diagnosticSelect').onchange = () => { state.diagnostic = $('diagnosticSelect').value; editor.pending = null; updateUI(); };
for (const [id, key, min, max] of [['wallHeightInput', 'wallHeight', 0.1, 20], ['wallThicknessInput', 'wallThickness', 0.01, 2]]) $(id).onchange = () => {
  const v = Number($(id).value); if (!Number.isFinite(v) || v < min || v > max) { $(id).value = state[key]; toast(`${min}〜${max}mの値を入力してください。`, true); return; }
  state[key] = v; markDirty(); updateUI();
};
$('layoutIdInput').onchange = () => { const text = $('layoutIdInput').value.trim(); if (!text) { $('layoutIdInput').value = state.layoutId; toast('レイアウトIDは空にできません。', true); return; } state.layoutId = text; markDirty(); updateUI(); };
$('applyWidthButton').onclick = () => {
  const width = Number($('widthInput').value), pixels = boundsOf(state.graph.nodes).width;
  if (!(width >= 0.01 && width <= 10000) || pixels < 0.01) { toast('幅がある間取りと、0.01〜10000mの幅を指定してください。垂直な壁だけの場合は壁の長さで縮尺を設定してください。', true); return; }
  state.pixelsPerMeter = pixels / width; state.calibrated = true; markDirty(); updateUI(); toast(`間取りの幅を${width}mに設定しました。`);
};
$('applyReferenceButton').onclick = () => {
  const length = Number($('referenceLengthInput').value), edge = graphSegments(state.graph).find(s => s.id === state.selected);
  if (!edge || !(length >= 0.01 && length <= 10000)) { toast('壁を選び、0.01〜10000mの長さを入力してください。', true); return; }
  state.pixelsPerMeter = distance(edge.a, edge.b) / length; state.calibrated = true; $('widthInput').value = (boundsOf(state.graph.nodes).width / state.pixelsPerMeter).toFixed(2); markDirty(); updateUI(); toast('選択した壁を基準に縮尺を設定しました。');
};
$('downloadButton').onclick = saveLayout; $('dialogDownloadButton').onclick = saveLayout; $('sendButton').onclick = sendLayout; $('saveProjectButton').onclick = saveProject;
$('showJsonButton').onclick = () => { try { $('jsonContent').textContent = JSON.stringify(getLayout(), null, 2); $('jsonDialog').showModal(); } catch (error) { toast(error.message, true); } };
$('copyJsonButton').onclick = async () => {
  const text = $('jsonContent').textContent;
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else { const area = document.createElement('textarea'); area.value = text; $('jsonDialog').appendChild(area); area.select(); const success = document.execCommand('copy'); area.remove(); if (!success) throw new Error('copy unavailable'); }
    toast('JSONをコピーしました。');
  } catch { toast('自動コピーできませんでした。JSONを選択してコピーするか、ファイルとして保存してください。', true); }
};
$('helpButton').onclick = () => $('helpDialog').showModal();
document.querySelectorAll('[data-close-dialog]').forEach(button => button.onclick = () => $(button.dataset.closeDialog).close());
for (const id of ['helpDialog', 'jsonDialog']) $(id).addEventListener('click', e => { if (e.target === $(id)) { const r = $(id).getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) $(id).close(); } });
$('newButton').onclick = () => {
  if (state.dirty && !confirm('現在の作業を破棄して新しく始めますか？')) return;
  Object.assign(state, { mode: 'input', view: '2d', paths:null, manuallyEdited:false, graph: EMPTY(), source: null, rectified: null, binary: null, skeleton: null, corners: [], sourceName: '', width: 0, height: 0, hasResult: false, pendingCrop: false, selected: null, dirty: false, calibrated: false, diagnostic: 'none', tool: 'select', layoutId: newId(), origin: { x: 0, y: 0 }, pixelsPerMeter: 100 });
  history.reset(state.graph); editor.pending = null; syncForm(); updateUI({ fit: true });
};
let dragDepth = 0;
const shell = $('canvasShell');
shell.addEventListener('dragenter', e => { e.preventDefault(); if (!state.busy) { dragDepth++; $('dropOverlay').hidden = false; } });
shell.addEventListener('dragover', e => e.preventDefault());
shell.addEventListener('dragleave', e => { e.preventDefault(); dragDepth--; if (dragDepth <= 0) $('dropOverlay').hidden = true; });
shell.addEventListener('drop', async e => { e.preventDefault(); dragDepth = 0; $('dropOverlay').hidden = true; if (state.busy) return; const file = e.dataTransfer.files?.[0]; if (!file) return; if (file.name.toLowerCase().endsWith('.json')) await importJson(file); else await importImage(file, file.name); });
window.addEventListener('beforeunload', e => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });
window.addEventListener('keydown', e => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) || document.querySelector('dialog[open]')) return;
  if (document.activeElement === $('editorCanvas')) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
});
$('destinationMode').value=destination.mode; $('targetHostInput').value=destination.host; $('targetPortInput').value=destination.port; updateDestination();
syncForm(); updateUI(); checkServer(); setInterval(checkServer, 20000);
// A small read-only testing surface exposes the document, not a bypass of image recognition.
Object.defineProperty(window, '__paperSpace', { value: { getGraph: () => structuredClone(state.graph), getLayout: () => getLayout(), getMode: () => state.mode, getConfig:()=>({...state.config}) }, writable: false });
