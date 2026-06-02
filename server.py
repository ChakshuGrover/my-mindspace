import http.server
import socketserver
import urllib.request
import urllib.error
from urllib.parse import urlparse, parse_qs, urljoin
import json
import re
import html as html_lib
import traceback

PORT = 8000

def parse_html_metadata(html, base_url):
    # Find all meta tags
    meta_tags = re.findall(r'<meta\s+([^>]+)>', html, re.IGNORECASE)
    
    og_title = ""
    og_desc = ""
    og_image = ""
    twitter_image = ""
    desc_val = ""
    
    for tag in meta_tags:
        attrs = {}
        for attr in re.finditer(r'([a-zA-Z0-9:-]+)\s*=\s*(?:["\']([^"\']*)["\']|([^\s>]+))', tag):
            key = attr.group(1).lower()
            val = attr.group(2) or attr.group(3) or ""
            attrs[key] = val
            
        prop = attrs.get('property', '').lower()
        name = attrs.get('name', '').lower()
        val = attrs.get('content', '')
        
        if prop == 'og:title':
            og_title = val
        elif prop == 'og:description':
            og_desc = val
        elif prop == 'og:image':
            og_image = val
        elif name == 'twitter:image':
            twitter_image = val
        elif name == 'description':
            desc_val = val

    # Parse title tag
    title_match = re.search(r'<title[^>]*>(.*?)</title>', html, re.IGNORECASE | re.DOTALL)
    title_tag = title_match.group(1).strip() if title_match else ""
    title_tag = re.sub(r'<[^>]+>', '', title_tag)
    
    title = og_title or title_tag or base_url.split('/')[-1] or base_url
    description = og_desc or desc_val or ""
    image = og_image or twitter_image or ""
    
    # Try finding link rel="image_src"
    if not image:
        link_tags = re.findall(r'<link\s+([^>]+)>', html, re.IGNORECASE)
        for tag in link_tags:
            attrs = {}
            for attr in re.finditer(r'([a-zA-Z0-9:-]+)\s*=\s*(?:["\']([^"\']*)["\']|([^\s>]+))', tag):
                key = attr.group(1).lower()
                val = attr.group(2) or attr.group(3) or ""
                attrs[key] = val
            if attrs.get('rel', '').lower() == 'image_src' and attrs.get('href'):
                image = attrs.get('href')
                break
                
    # Try body images
    if not image:
        body_match = re.search(r'<body[^>]*>(.*?)</body>', html, re.IGNORECASE | re.DOTALL)
        body_content = body_match.group(1) if body_match else html
        img_match = re.search(r'<img\s+[^>]*src=["\']([^"\']+)["\']', body_content, re.IGNORECASE)
        if img_match:
            image = img_match.group(1)
            
    if image:
        image = urljoin(base_url, image)
        
    return {
        "title": html_lib.unescape(title).strip(),
        "description": html_lib.unescape(description).strip(),
        "image": image.strip()
    }

def scrape_url_metadata(url):
    req = urllib.request.Request(
        url, 
        headers={
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
    )
    with urllib.request.urlopen(req, timeout=10) as response:
        content_type = response.headers.get('Content-Type', '')
        if 'text/html' not in content_type.lower():
            return {
                "title": url.split('/')[-1] or url,
                "description": "",
                "image": ""
            }
            
        html_bytes = response.read()
        try:
            html_text = html_bytes.decode('utf-8', errors='replace')
        except Exception:
            html_text = html_bytes.decode('latin-1', errors='replace')
            
        return parse_html_metadata(html_text, url)


class MindProxyHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith('/api/scrape'):
            parsed_url = urlparse(self.path)
            params = parse_qs(parsed_url.query)
            target_url = params.get('url', [None])[0]
            
            if not target_url:
                self.send_response(400)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(b'{"error": "Missing URL parameter"}')
                return
                
            try:
                metadata = scrape_url_metadata(target_url)
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps(metadata).encode('utf-8'))
            except Exception as e:
                traceback.print_exc()
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode('utf-8'))
        else:
            super().do_GET()

    def do_POST(self):
        if self.path.startswith('/api/gemini'):
            parsed_url = urlparse(self.path)
            params = parse_qs(parsed_url.query)
            
            api_key = params.get('key', [None])[0]
            if not api_key or api_key.strip() == '' or api_key == 'undefined' or api_key == 'null':
                import os
                api_key = os.environ.get('GEMINI_API_KEY')
            
            model = params.get('model', ['gemma-4-31b-it'])[0]
            
            if not api_key:
                self.send_response(400)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(b'{"error": "Missing Gemini API Key"}')
                return
                
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            
            google_url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
            
            req = urllib.request.Request(
                google_url,
                data=post_data,
                headers={'Content-Type': 'application/json'},
                method='POST'
            )
            
            try:
                with urllib.request.urlopen(req, timeout=90) as response:
                    res_data = response.read()
                    self.send_response(response.status)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(res_data)
            except urllib.error.HTTPError as e:
                res_data = e.read()
                self.send_response(e.code)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(res_data)
            except Exception as e:
                traceback.print_exc()
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode())
        else:
            super().do_POST()

socketserver.TCPServer.allow_reuse_address = True

with socketserver.TCPServer(("", PORT), MindProxyHandler) as httpd:
    print(f"myMindScape Secure Proxy Server running at http://localhost:{PORT}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping proxy server.")
