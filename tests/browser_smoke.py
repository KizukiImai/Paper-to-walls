"""Optional full HTTP browser smoke test (Python + Playwright required).

Run from the repository root: python tests/browser_smoke.py
Uses an isolated temporary data directory; never changes user-data/.
CHROMIUM_PATH may select a locally installed Chromium/Chrome executable.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'test-results' / 'http-browser'


def main() -> None:
    node = shutil.which('node')
    if not node:
        raise SystemExit('Node.js 20以上が必要です。nodeをPATHに追加してください。')
    OUT.mkdir(parents=True, exist_ok=True)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    base = f'http://127.0.0.1:{port}'
    with tempfile.TemporaryDirectory(prefix='paper-space-test-') as temporary:
        environment = dict(os.environ, PORT=str(port), HOST='127.0.0.1', DATA_DIR=temporary)
        with (OUT / 'server.log').open('w', encoding='utf-8') as log:
            server = subprocess.Popen([node, 'server/index.mjs'], cwd=ROOT, env=environment, stdout=log, stderr=subprocess.STDOUT)
            try:
                for _ in range(100):
                    if server.poll() is not None:
                        raise RuntimeError(f'テストサーバーが終了しました。{OUT / "server.log"} を確認してください。')
                    try:
                        with urllib.request.urlopen(base + '/api/health', timeout=1) as response:
                            if response.status == 200:
                                break
                    except (urllib.error.URLError, TimeoutError):
                        time.sleep(0.1)
                else:
                    raise RuntimeError('テストサーバーの起動を確認できませんでした。')

                with sync_playwright() as playwright:
                    launch = {'headless': True}
                    if os.environ.get('CHROMIUM_PATH'):
                        launch['executable_path'] = os.environ['CHROMIUM_PATH']
                    browser = playwright.chromium.launch(**launch)
                    page = browser.new_page(viewport={'width': 1440, 'height': 1080}, device_scale_factor=1, accept_downloads=True)
                    errors: list[str] = []
                    page.on('pageerror', lambda error: errors.append(str(error)))
                    page.on('dialog', lambda dialog: dialog.accept())
                    try:
                        page.goto(base, wait_until='networkidle')
                        page.screenshot(path=str(OUT / '01-empty.png'), full_page=True)
                        page.locator('#sampleButton').click()
                        page.wait_for_function("document.querySelector('#wallCount').textContent === '08'", timeout=45000)
                        assert page.evaluate('window.__paperSpace.getMode()') == 'edit'
                        page.screenshot(path=str(OUT / '02-editor.png'), full_page=True)
                        page.locator('#view3dButton').click()
                        page.wait_for_timeout(1200)
                        assert page.locator('#previewCanvas').get_attribute('data-renderer') in ('webgl', 'software')
                        page.screenshot(path=str(OUT / '03-preview.png'), full_page=True)
                        page.locator('#widthInput').fill('4')
                        page.locator('#applyWidthButton').click()
                        with page.expect_download() as download:
                            page.locator('#downloadButton').click()
                        download.value.save_as(str(OUT / 'exported-layout.json'))
                        layout = json.loads((OUT / 'exported-layout.json').read_text(encoding='utf-8'))
                        assert layout['schemaVersion'] == 1 and layout['units'] == 'm'
                        assert len(layout['walls']) == 8
                        xs = [wall[key] for wall in layout['walls'] for key in ('ax', 'bx')]
                        assert abs(max(xs) - min(xs) - 4) < 0.001

                        # Preserve the legacy local-storage mode as a regression check.
                        page.locator('#destinationMode').select_option('local')
                        # Actual HTTP request from the page, not a mocked response.
                        with page.expect_response(lambda response: response.url == base + '/api/layouts' and response.request.method == 'POST') as sent:
                            page.locator('#sendButton').click()
                        assert sent.value.status == 201
                        latest = page.request.get(base + '/api/layouts/latest')
                        assert latest.status == 200
                        assert latest.json()['walls'] == layout['walls']
                        assert latest.json()['revision'] == 1
                        assert (Path(temporary) / 'latest-layout.json').exists()

                        # Real browser download and editable-project restoration.
                        snapshot = page.evaluate('window.__paperSpace.getLayout()')
                        with page.expect_download() as project:
                            page.locator('#saveProjectButton').click()
                        project_path = OUT / 'saved-project.paper-space.json'
                        project.value.save_as(str(project_path))
                        page.locator('#newButton').click()
                        page.locator('#jsonInput').set_input_files(str(project_path))
                        page.wait_for_function("document.querySelector('#wallCount').textContent === '08'", timeout=30000)
                        restored = page.evaluate('window.__paperSpace.getLayout()')
                        assert restored == snapshot
                        page.set_viewport_size({'width': 390, 'height': 844})
                        page.screenshot(path=str(OUT / '04-mobile.png'), full_page=True)
                        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
                        assert not errors, errors
                        print('HTTPブラウザテスト成功: 認識、編集画面、3D、縮尺、JSON保存、API送信、作業復元、モバイル幅。')
                    except Exception:
                        try:
                            page.screenshot(path=str(OUT / 'failure.png'), full_page=True)
                        except Exception:
                            pass
                        raise
                    finally:
                        browser.close()
            finally:
                server.terminate()
                try:
                    server.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait()


if __name__ == '__main__':
    main()
