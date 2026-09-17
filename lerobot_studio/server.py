"""本地 HTTP 服务：显式数据集 token 防止导入后旧请求写错目录。"""
import argparse
import json
import logging
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import yaml

from .annotations import AnnotationStore
from .dataset import Dataset


class Studio:
    def __init__(self, config):
        self.config = config
        self.root = Path(config['dataset']['browse_root']).expanduser().resolve()
        self.datasets = {}
        self.lock = threading.RLock()

    def checked_path(self, value):
        path = Path(value).expanduser().resolve()
        if not path.is_relative_to(self.root) or not path.is_dir():
            raise ValueError('请选择 browse_root 内存在的目录')
        return path

    def open(self, value):
        path = self.checked_path(value)
        with self.lock:
            # 同一目录共享存储锁；多个标签页不会各自缓存标注。
            for token, (dataset, annotations) in self.datasets.items():
                if dataset.root == path:
                    return self.summary(token, dataset, annotations)
            dataset = Dataset(path, self.config)
            annotations = AnnotationStore(path, self.config['annotation']['labels'])
            token = uuid.uuid4().hex
            result = self.summary(token, dataset, annotations)
            self.datasets[token] = dataset, annotations
            return result

    def summary(self, token, dataset, annotations):
        return {'token': token, 'name': dataset.root.name, 'path': str(dataset.root),
                'fps': dataset.fps, 'annotations': annotations.read()['episodes'],
                'episodes': [{'id': key, 'length': int(row['length']), 'tasks': row.get('tasks', [])}
                             for key, row in sorted(dataset.episodes.items())]}

    def browse(self, value):
        path = self.checked_path(value or self.root)
        folders = []
        for child in sorted(path.iterdir()):
            if child.is_dir() and child.resolve().is_relative_to(self.root) and not child.name.startswith('.'):
                folders.append({'name': child.name, 'path': str(child),
                                'dataset': (child / 'meta/info.json').is_file()})
        return {'path': str(path), 'parent': str(path.parent) if path != self.root else None,
                'dataset': (path / 'meta/info.json').is_file(), 'folders': folders}


class RequestHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        logging.debug(format, *args)

    def respond(self, status, data, mime='application/json; charset=utf-8'):
        body = json.dumps(data, ensure_ascii=False, allow_nan=False).encode() if isinstance(data, (dict, list)) else data
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.dispatch(False)

    def do_POST(self):
        self.dispatch(True)

    def dispatch(self, post):
        try:
            parsed = urlparse(self.path)
            route = parsed.path
            args = {key: values[0] for key, values in parse_qs(parsed.query).items()}
            studio = self.server.studio
            if post:
                # 限制为同源 JSON 请求，避免第三方网页触发本机文件写入。
                origin = self.headers.get('Origin')
                if origin and urlparse(origin).netloc != self.headers.get('Host'):
                    return self.respond(403, {'error': '不允许跨域写入'})
                if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
                    raise ValueError('请求必须为 JSON')
                length = int(self.headers.get('Content-Length', 0))
                if not 0 < length <= 65536:
                    raise ValueError('请求大小无效')
                args = json.loads(self.rfile.read(length))
            if route == '/api/config' and not post:
                return self.respond(200, studio.config)
            if route == '/api/browse' and not post:
                return self.respond(200, studio.browse(args.get('path')))
            if route == '/api/open' and post:
                return self.respond(200, studio.open(args['path']))
            if route.startswith('/api/'):
                dataset, annotations = studio.datasets[args['token']]
                index = int(args['episode'])
                episode = dataset.episode(index)
                if route == '/api/episode' and not post:
                    return self.respond(200, dataset.detail(index))
                if route == '/api/frames' and not post:
                    return self.respond(200, dataset.frames(index, int(args['frame'])))
                if route == '/api/annotation' and post:
                    frame = int(args['frame'])
                    if not 0 <= frame < episode['length']:
                        raise ValueError('标注帧越界')
                    return self.respond(200, annotations.save(index, args['labels'], args.get('note', ''), frame))
            static = {'/': ('index.html', 'text/html; charset=utf-8'),
                      '/app.js': ('app.js', 'text/javascript; charset=utf-8'),
                      '/style.css': ('style.css', 'text/css; charset=utf-8')}
            if route in static and not post:
                name, mime = static[route]
                return self.respond(200, (Path(__file__).parent / 'static' / name).read_bytes(), mime)
            self.respond(404, {'error': '资源不存在'})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except (ValueError, KeyError, OSError) as exc:
            self.respond(400, {'error': str(exc)})
        except Exception as exc:
            logging.exception('请求失败')
            self.respond(500, {'error': f'读取失败：{exc}'})


def main():
    parser = argparse.ArgumentParser(description='LeRobot v3 数据质检工作台')
    parser.add_argument('--config', type=Path, default=Path(__file__).resolve().parents[1] / 'config.yaml')
    args = parser.parse_args()
    config = yaml.safe_load(args.config.read_text(encoding='utf-8'))
    logging.basicConfig(level=logging.INFO)
    server = ThreadingHTTPServer((config['server']['host'], int(config['server']['port'])), RequestHandler)
    server.studio = Studio(config)
    print(f"LeRobotStudio: http://{config['server']['host']}:{config['server']['port']}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        for dataset, _ in server.studio.datasets.values():
            dataset.close()
