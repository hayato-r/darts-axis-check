#!/usr/bin/env python3
"""開発用サーバー: キャッシュ無効ヘッダー付きで app/ を配信する。

標準の `python3 -m http.server` はキャッシュ制御ヘッダーを送らないため、
Safari が古い JS モジュールを再利用してしまう(2026-07-10 に実際に発生)。
このサーバーは Cache-Control: no-store を全レスポンスに付与し、
常にディスク上の最新ファイルが配信されることを保証する。

使い方: python3 serve.py  →  http://localhost:8421 / http://<MacのIP>:8421
"""
import http.server
import os

PORT = 8421


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Expires", "0")
        super().end_headers()


if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    print(f"Serving app/ with no-store cache headers on port {PORT}")
    http.server.ThreadingHTTPServer(("", PORT), NoCacheHandler).serve_forever()
