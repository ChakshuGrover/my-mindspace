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

def fetch_homepage_image(base_url, title):
    try:
        parsed = urlparse(base_url)
        host_parts = parsed.netloc.split('.')
        domain = '.'.join(host_parts[-2:]) if len(host_parts) >= 2 else parsed.netloc
        
        # Collect keywords
        keywords = []
        if title:
            for w in re.findall(r'[a-zA-Z0-9]+', title):
                if len(w) >= 3:
                    keywords.append(w.lower())
                    
        sub = host_parts[0]
        if sub and sub != 'www' and len(sub) >= 2:
            keywords.append(sub.lower())
            
        for w in re.findall(r'[a-zA-Z0-9]+', parsed.path):
            lower = w.lower()
            if len(lower) >= 3 and lower not in ['learn', 'home', 'section', 'lesson', 'course']:
                keywords.append(lower)
                
        keywords = list(set(keywords))
        
        urls_to_try = [
            f"https://www.{domain}/",
            f"https://{domain}/",
            f"https://{parsed.netloc}/"
        ]
        
        unique_urls = []
        for url in urls_to_try:
            if url not in unique_urls:
                unique_urls.append(url)
                
        for home_url in unique_urls:
            try:
                req = urllib.request.Request(
                    home_url, 
                    headers={
                        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                    }
                )
                with urllib.request.urlopen(req, timeout=3) as response:
                    content_type = response.headers.get('Content-Type', '')
                    if 'text/html' not in content_type.lower():
                        continue
                    
                    html_bytes = response.read()
                    try:
                        html_text = html_bytes.decode('utf-8', errors='replace')
                    except Exception:
                        html_text = html_bytes.decode('latin-1', errors='replace')
                        
                    img_matches = re.findall(r'<img\s+[^>]*src=["\']([^"\']+)["\']', html_text, re.IGNORECASE)
                    if not img_matches:
                        continue
                        
                    scored_images = []
                    for src in img_matches:
                        src = src.strip()
                        if src.startswith('//'):
                            resolved = 'https:' + src
                        else:
                            resolved = urljoin(home_url, src)
                            
                        lower = resolved.lower()
                        if any(x in lower for x in ['pixel', 'loader', 'spacer', 'no-image', 'placeholder']):
                            continue
                            
                        score = 0
                        for word in keywords:
                            if word in lower:
                                score += 50
                                
                        if any(x in lower for x in ['banner', 'hero', 'cover']):
                            score += 30
                        if any(x in lower for x in ['desktop', '-web', '_web']):
                            score += 20
                        if any(x in lower for x in ['mobile', '-thumb', '_thumb']):
                            score -= 15
                        if any(x in lower for x in ['logo', 'brand']):
                            score += 15
                        if lower.endswith('.svg'):
                            score += 10
                            
                        scored_images.append((resolved, score))
                        
                    if scored_images:
                        scored_images.sort(key=lambda x: x[1], reverse=True)
                        if scored_images[0][1] >= 40:
                            return scored_images[0][0]
            except Exception:
                continue
    except Exception:
        pass
    return None

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
    
    candidate_images = []

    def add_candidate(src, base_score, source_tag=None):
        if not src:
            return
        resolved = src.strip()
        if resolved.startswith('//'):
            resolved = 'https:' + resolved
        elif resolved.startswith('/'):
            resolved = urljoin(base_url, resolved)
        elif not resolved.startswith('http://') and not resolved.startswith('https://'):
            resolved = urljoin(base_url, resolved)
            
        try:
            from urllib.parse import urlparse
            parsed_url = urlparse(resolved)
            if '.' not in parsed_url.netloc and parsed_url.netloc != 'localhost':
                return
            
            candidate_images.append({
                'url': resolved,
                'baseScore': base_score,
                'attrs': source_tag or {}
            })
        except Exception:
            pass

    # 1. Add OG / Twitter images
    add_candidate(og_image, 100)
    add_candidate(twitter_image, 100)

    # 2. Add link rel="image_src"
    link_tags = re.findall(r'<link\s+([^>]+)>', html, re.IGNORECASE)
    for tag in link_tags:
        attrs = {}
        for attr in re.finditer(r'([a-zA-Z0-9:-]+)\s*=\s*(?:["\']([^"\']*)["\']|([^\s>]+))', tag):
            key = attr.group(1).lower()
            val = attr.group(2) or attr.group(3) or ""
            attrs[key] = val
        if attrs.get('rel', '').lower() == 'image_src' and attrs.get('href'):
            add_candidate(attrs.get('href'), 80)

    # 3. Add body images
    body_match = re.search(r'<body[^>]*>(.*?)</body>', html, re.IGNORECASE | re.DOTALL)
    body_content = body_match.group(1) if body_match else html
    img_tags = re.findall(r'<img\s+([^>]+)>', body_content, re.IGNORECASE)
    for tag in img_tags:
        attrs = {}
        for attr in re.finditer(r'([a-zA-Z0-9:-]+)\s*=\s*(?:["\']([^"\']*)["\']|([^\s>]+))', tag):
            key = attr.group(1).lower()
            val = attr.group(2) or attr.group(3) or ""
            attrs[key] = val
        if attrs.get('src'):
            add_candidate(attrs.get('src'), 50, attrs)

    # Keywords for scoring
    keywords = []
    if title:
        for w in re.findall(r'[a-zA-Z0-9]+', title):
            if len(w) >= 3:
                keywords.append(w.lower())
    try:
        from urllib.parse import urlparse
        parsed = urlparse(base_url)
        sub = parsed.netloc.split('.')[0]
        if sub and sub != 'www' and len(sub) >= 2:
            keywords.append(sub.lower())
        for w in re.findall(r'[a-zA-Z0-9]+', parsed.path):
            lower = w.lower()
            if len(lower) >= 3 and lower not in ['learn', 'home', 'section', 'lesson', 'course']:
                keywords.append(lower)
    except Exception:
        pass
    keywords = list(set(keywords))

    # Score candidates
    scored_candidates = []
    for candidate in candidate_images:
        lower = candidate['url'].lower()
        
        if any(x in lower for x in ['pixel', 'loader', 'spacer', 'no-image', 'placeholder']):
            continue

        width = None
        height = None
        attrs = candidate['attrs']
        
        if attrs.get('width'):
            try:
                width = int(attrs.get('width'))
            except Exception:
                pass
        if attrs.get('height'):
            try:
                height = int(attrs.get('height'))
            except Exception:
                pass

        try:
            from urllib.parse import urlparse, parse_qs
            parsed_url = urlparse(candidate['url'])
            params = parse_qs(parsed_url.query)
            if 'width' in params or 'w' in params:
                val = params.get('width') or params.get('w')
                if val:
                    width = int(val[0])
            if 'height' in params or 'h' in params:
                val = params.get('height') or params.get('h')
                if val:
                    height = int(val[0])
        except Exception:
            pass

        shopify_size_match = re.search(r'_(\d+)x', candidate['url'])
        if shopify_size_match:
            size_val = int(shopify_size_match.group(1))
            width = size_val
            height = size_val

        if (width is not None and width < 200) or (height is not None and height < 200):
            continue

        check_str = f"{attrs.get('alt', '')} {attrs.get('class', '')} {attrs.get('id', '')} {attrs.get('aria-label', '')} {lower}".lower()
        
        if any(x in check_str for x in ['favicon', 'avatar', 'icon', 'loader']) or lower.endswith('.svg'):
            continue

        score = candidate['baseScore']

        if 'logo' in check_str or 'brand' in check_str:
            score -= 20

        for word in keywords:
            if word in check_str:
                score += 30

        if any(x in lower for x in ['banner', 'hero', 'cover']):
            score += 30
        if any(x in lower for x in ['desktop', '-web', '_web']):
            score += 20
        if any(x in lower for x in ['mobile', '-thumb', '_thumb']):
            score -= 15

        scored_candidates.append((candidate['url'], score))

    image = ""
    if scored_candidates:
        scored_candidates.sort(key=lambda x: x[1], reverse=True)
        if scored_candidates[0][1] >= 30:
            image = scored_candidates[0][0]
            
    # Fallback to homepage smart logo/banner or brand favicon if no valid main content image was found
    if not image:
        try:
            home_img = fetch_homepage_image(base_url, title)
            if home_img:
                image = home_img
            else:
                from urllib.parse import urlparse
                parsed = urlparse(base_url)
                host_parts = parsed.netloc.split('.')
                domain = '.'.join(host_parts[-2:]) if len(host_parts) >= 2 else parsed.netloc
                image = f"https://t0.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=http://{domain}&size=256"
        except Exception:
            image = f"https://image.thum.io/get/width/600/crop/800/maxAge/24/{base_url}"
        
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
    print(f"MyMindSpace Secure Proxy Server running at http://localhost:{PORT}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping proxy server.")
