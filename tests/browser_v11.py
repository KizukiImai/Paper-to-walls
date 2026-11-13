"""v1.1 UI + LAN relay smoke test. Default uses normal HTTP browser transport.

python tests/browser_v11.py
python tests/browser_v11.py --isolated

--isolated embeds the SAME source modules as Blob URLs and substitutes only
browser fetch transport with Python HTTP requests to the real test servers.
Module imports are bundled into IIFEs and a real classic Blob Worker in this
isolated mode. The application itself still uses ES modules / module Workers.
It is for restricted test containers, NOT a claim of normal HTTP browser E2E.
Requires optional developer dependencies: Python Playwright and Chromium.
"""
from pathlib import Path
import argparse, base64, contextlib, json, os, re, shutil, socket, subprocess, tempfile, time
import urllib.request, urllib.error
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'test-results'/'v11-browser'

def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0));return sock.getsockname()[1]

@contextlib.contextmanager
def running_server(receiver=False):
    with tempfile.TemporaryDirectory(prefix='paper-v11-') as folder:
        port=free_port()
        env=dict(os.environ,PORT=str(port),HOST='127.0.0.1',DATA_DIR=folder,RECEIVE_ONLY='1' if receiver else '0')
        with (OUT/('receiver.log' if receiver else 'sender.log')).open('w') as log:
            process=subprocess.Popen([shutil.which('node'),'server/index.mjs'],cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT)
            base=f'http://127.0.0.1:{port}'
            try:
                for _ in range(100):
                    try:
                        with urllib.request.urlopen(base+'/api/health',timeout=1):break
                    except (urllib.error.URLError,TimeoutError):time.sleep(.1)
                else:raise RuntimeError('server not started')
                yield base,port,Path(folder)
            finally:
                process.terminate()
                try:process.wait(timeout=5)
                except subprocess.TimeoutExpired:process.kill();process.wait()

def http_bridge(base,request):
    url=request['url']
    if url.startswith('http'):raise ValueError('test bridge only accepts app-relative URLs')
    data=request.get('body')
    req=urllib.request.Request(base+'/'+url.lstrip('/'),data=data.encode() if data is not None else None,method=request.get('method','GET'),headers=request.get('headers',{}))
    try:response=urllib.request.urlopen(req,timeout=15)
    except urllib.error.HTTPError as error:response=error
    with response:
        return {'status':response.status,'body':base64.b64encode(response.read()).decode(),'headers':dict(response.headers)}

def isolated_load(page,base):
    html=(ROOT/'web/index.html').read_text()
    html=re.sub(r'<script type="module" src="app.js"></script>','',html)
    html=re.sub(r'<link rel="(?:stylesheet|icon)"[^>]*>','',html)
    page.set_content(html)
    page.add_style_tag(content=(ROOT/'web/styles.css').read_text())
    page.expose_function('__testHttp',lambda request:http_bridge(base,request))
    import posixpath
    sources={str(p.relative_to(ROOT/'web')):p.read_text() for p in (ROOT/'web').rglob('*.js')}
    def bundle(entry):
        done=set(); chunks=['const __modules = {};']
        def build(name):
            if name in done: return
            text=sources[name]
            def dependency(match):
                names,rel=match.groups()
                dep=posixpath.normpath(posixpath.join(posixpath.dirname(name),rel))
                build(dep)
                return 'const {'+names+'} = __modules['+json.dumps(dep)+'];'
            text=re.sub(r"import\s*\{([^}]+)\}\s*from\s*['\"]([^'\"]+)['\"];?",dependency,text)
            names=re.findall(r'export\s+(?:async\s+)?(?:const|class|function)\s+(\w+)',text)
            text=re.sub(r'\bexport\s+','',text)
            if name=='app.js': text=text.replace("new URL('./recognizer.worker.js', import.meta.url)",'window.__testWorkerURL').replace("{ type: 'module' }","{ type: 'classic' }")
            chunks.append('__modules['+json.dumps(name)+']=(()=>{\n'+text+'\nreturn {'+','.join(names)+'};})();')
            done.add(name)
        build(entry)
        return '(()=>{\n'+'\n'.join(chunks)+'\n})()'
    worker=bundle('recognizer.worker.js')
    page.evaluate("text=>{window.__testWorkerURL=URL.createObjectURL(new Blob([text],{type:'text/javascript'}));}",worker)
    page.evaluate("""()=>{
      const nativeFetch=window.fetch.bind(window);
      window.fetch=async (url,init={})=>{
        if(/^(data:|blob:)/.test(String(url))) return nativeFetch(url,init);
        const r=await window.__testHttp({url:String(url),method:init.method||'GET',body:init.body,headers:init.headers||{}});
        const bytes=Uint8Array.from(atob(r.body),c=>c.charCodeAt(0));
        return new Response([204,304].includes(r.status)?null:bytes,{status:r.status,headers:r.headers});
      };
    }""")
    main_bundle=bundle('app.js')
    page.evaluate(main_bundle)


def set_slider(page,id,value):
    page.locator('#'+id).evaluate('(el,v)=>{el.value=v;el.dispatchEvent(new Event("input",{bubbles:true}));}',str(value))

def wait_ready(page):
    page.wait_for_function("!document.querySelector('#applyStraightenButton').disabled",timeout=45000)


def main():
    args=argparse.ArgumentParser();args.add_argument('--isolated',action='store_true');options=args.parse_args()
    OUT.mkdir(parents=True,exist_ok=True)
    with running_server() as (base,_,sender_dir),running_server(True) as (receiver,port,receiver_dir),sync_playwright() as pw:
        executable=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium')
        browser=pw.chromium.launch(headless=True,**({'executable_path':executable} if executable else {}))
        page=browser.new_page(viewport={'width':1440,'height':1080},accept_downloads=True)
        page.on('requestfailed',lambda r:print('failed request:',r.url[:150],r.failure,flush=True))
        errors=[];page.on('pageerror',lambda error:errors.append(str(error)));page.on('dialog',lambda d:d.accept())
        try:
            if options.isolated:isolated_load(page,base)
            else:page.goto(base,wait_until='networkidle')
            page.wait_for_function("!document.querySelector('#checkTargetButton').disabled")
            page.locator('#sampleSelect').select_option('wavy-line');page.locator('#sampleButton').click();wait_ready(page)
            set_slider(page,'straightnessInput',0);page.locator('#applyStraightenButton').click();wait_ready(page)
            low=page.evaluate('window.__paperSpace.getGraph().walls.length');assert low>1,low
            page.screenshot(path=str(OUT/'01-low-correction.png'),full_page=True)
            set_slider(page,'straightnessInput',80);page.locator('#applyStraightenButton').click();wait_ready(page)
            assert page.evaluate('window.__paperSpace.getGraph().walls.length')==1
            page.screenshot(path=str(OUT/'02-high-correction.png'),full_page=True)
            page.locator('#undoButton').click();assert page.evaluate('window.__paperSpace.getGraph().walls.length')==low
            page.locator('#redoButton').click();assert page.evaluate('window.__paperSpace.getGraph().walls.length')==1
            # Real JSON export, including exact scale.
            page.locator('#widthInput').fill('4');page.locator('#applyWidthButton').click()
            with page.expect_download() as downloaded:page.locator('#downloadButton').click()
            exported=OUT/'corrected.json';downloaded.value.save_as(str(exported));layout=json.loads(exported.read_text())
            assert len(layout['walls'])==1
            wall=layout['walls'][0];assert abs(abs(wall['bx']-wall['ax'])-4)<.001
            assert abs(wall['ay']-wall['by'])<.001
            # Two real Node servers, independent persistence, browser-driven controls.
            page.locator('#targetHostInput').fill('127.0.0.1');page.locator('#targetPortInput').fill(str(port));page.locator('#checkTargetButton').click()
            page.wait_for_function("document.querySelector('#targetStatus').classList.contains('success')")
            page.locator('#sendButton').click()
            page.wait_for_function("document.querySelector('#targetStatus').textContent.includes('受信PCに保存済み')")
            received=json.loads((receiver_dir/'latest-layout.json').read_text());assert received['walls']==layout['walls']
            assert not (sender_dir/'latest-layout.json').exists()
            # Keep original traced paths across save/load, then lower the amount again.
            with page.expect_download() as saved:page.locator('#saveProjectButton').click()
            project_path=OUT/'working.paper-space.json';saved.value.save_as(str(project_path))
            project=json.loads(project_path.read_text());assert project['config']['straightness']==80;assert project['recognitionPaths']
            page.locator('#newButton').click();page.locator('#jsonInput').set_input_files(str(project_path));wait_ready(page)
            set_slider(page,'straightnessInput',0);page.locator('#applyStraightenButton').click();wait_ready(page)
            assert page.evaluate('window.__paperSpace.getGraph().walls.length')==low
            # The room contains T junctions; correction must reduce wobble, not erase rooms.
            page.locator('#sampleSelect').select_option('wavy-room');page.locator('#sampleButton').click();wait_ready(page)
            set_slider(page,'straightnessInput',80);page.locator('#applyStraightenButton').click();wait_ready(page)
            assert page.evaluate('window.__paperSpace.getGraph().walls.length')==8
            page.locator('#targetHostInput').fill('192.168.1.50');page.locator('#targetPortInput').fill('3001')
            page.screenshot(path=str(OUT/'03-room-corrected.png'),full_page=True)
            page.locator('#view3dButton').click();page.wait_for_timeout(1200)
            renderer=page.locator('#previewCanvas').get_attribute('data-renderer');assert renderer in ('webgl','software')
            page.screenshot(path=str(OUT/'04-3d.png'),full_page=True)
            page.set_viewport_size({'width':390,'height':844});page.screenshot(path=str(OUT/'05-mobile.png'),full_page=True)
            assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
            assert not errors,errors
            result={'mode':'isolated source + real HTTP bridge' if options.isolated else 'normal HTTP browser', 'lowCorrectionWalls':low,'highCorrectionWalls':1,'roomWalls':8,'receiverSaved':True,'senderNotModified':True,'projectPathsRestored':True,'undoRedo':True,'jsonExport':True,'renderer':renderer,'mobileNoHorizontalOverflow':True,'pageErrors':errors}
            (OUT/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2));print(json.dumps(result,ensure_ascii=False,indent=2))
        except Exception:
            page.screenshot(path=str(OUT/'failure.png'),full_page=True);print('PAGE ERRORS',errors);raise
        finally:browser.close()
if __name__=='__main__':main()
