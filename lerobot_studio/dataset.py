"""读取 v3 元数据、关节数据和共享视频中的精确帧。"""
from __future__ import annotations

import base64
import io
import json
import threading
from pathlib import Path

import av
import numpy as np
import pyarrow.parquet as pq


class Dataset:
    """一个数据目录的只读数据访问器；视频解码器由锁保护。"""

    def __init__(self, root: Path, config: dict):
        self.root, self.config = root, config
        self.info = json.loads((root / 'meta/info.json').read_text())
        if self.info.get('codebase_version') != 'v3.0':
            raise ValueError('仅支持 LeRobot v3.0 数据集')
        self.fps = float(self.info['fps'])
        self.episodes = {}
        for path in sorted((root / 'meta/episodes').rglob('*.parquet')):
            schema = pq.read_schema(path)
            columns = [n for n in schema.names if not n.startswith('stats/')]
            for row in pq.read_table(path, columns=columns).to_pylist():
                self.episodes[int(row['episode_index'])] = row
        if not self.episodes:
            raise ValueError('未找到 episode 元数据')
        self.cameras = [key for key, spec in self.info['features'].items() if spec['dtype'] == 'video']
        self.lock = threading.RLock()
        self.decoders = {}
        self.cached_episode = None
        self.cached_payload = None

    def episode(self, index: int) -> dict:
        if index not in self.episodes:
            raise ValueError('不存在的 episode ID')
        return self.episodes[index]

    def resolve(self, relative: str) -> Path:
        path = (self.root / relative).resolve()
        if not path.is_relative_to(self.root):
            raise ValueError('数据路径超出数据目录')
        return path

    def detail(self, index: int) -> dict:
        with self.lock:
            if self.cached_episode == index:
                return self.cached_payload
            episode = self.episode(index)
            feature = self.config['charts']['feature']
            path = self.resolve(self.info['data_path'].format(
                chunk_index=episode['data/chunk_index'], file_index=episode['data/file_index']))
            rows = pq.read_table(path, columns=['episode_index', 'frame_index', 'timestamp', feature],
                                 filters=[('episode_index', '=', index)]).to_pylist()
            rows.sort(key=lambda row: row['frame_index'])
            if len(rows) != int(episode['length']) or not rows:
                raise ValueError('episode 帧数与 parquet 数据不一致')
            values = np.asarray([row[feature] for row in rows], dtype=float)
            names = self.info['features'][feature].get('names')
            if isinstance(names, dict):
                names = next(iter(names.values()))
            names = names or [str(i) for i in range(values.shape[1])]
            groups = []
            for group in self.config['charts']['groups']:
                indices = group.get('indices') or [i for i, name in enumerate(names)
                                                    if name.startswith(group['prefix'])]
                if any(i < 0 or i >= values.shape[1] for i in indices):
                    raise ValueError('config.yaml 中的关节 indices 越界')
                groups.append({'title': group['title'], 'series': [
                    {'name': names[i], 'values': [float(v) if np.isfinite(v) else None for v in values[:, i]]}
                    for i in indices]})
            timestamps = [float(row['timestamp']) for row in rows]
            timestamps = [t - timestamps[0] for t in timestamps]
            self.cached_payload = {'id': index, 'length': len(rows), 'fps': self.fps,
                                   'timestamps': timestamps, 'groups': groups, 'cameras': self.cameras}
            self.cached_episode = index
            return self.cached_payload

    def frames(self, index: int, frame: int) -> dict:
        """所有相机在同一请求中完成解码，前端整组提交，避免串帧。"""
        with self.lock:
            detail = self.detail(index)
            if not 0 <= frame < detail['length']:
                raise ValueError('帧索引越界')
            episode = self.episode(index)
            images = []
            for camera in self.cameras:
                prefix = f'videos/{camera}'
                path = self.resolve(self.info['video_path'].format(
                    video_key=camera, chunk_index=episode[f'{prefix}/chunk_index'],
                    file_index=episode[f'{prefix}/file_index']))
                target = float(episode[f'{prefix}/from_timestamp']) + detail['timestamps'][frame]
                decoder = self.decoders.get(camera)
                if decoder is None or decoder.path != path:
                    if decoder:
                        decoder.close()
                    decoder = self.decoders[camera] = VideoDecoder(path)
                image = decoder.read(target, self.fps)
                output = io.BytesIO()
                image.save(output, format='JPEG', quality=self.config['playback']['jpeg_quality'])
                images.append('data:image/jpeg;base64,' + base64.b64encode(output.getvalue()).decode())
            return {'frame': frame, 'images': images}

    def close(self):
        for decoder in self.decoders.values():
            decoder.close()


class VideoDecoder:
    """顺序播放复用解码状态；跳帧时定位到前一个关键帧。"""

    def __init__(self, path: Path):
        self.path = path
        self.container = av.open(str(path))
        self.stream = self.container.streams.video[0]
        self.iterator = iter(self.container.decode(self.stream))
        self.current = None

    def read(self, target: float, fps: float):
        current_time = float(self.current.time) if self.current is not None else -1
        if self.current is None or target < current_time - 0.5 / fps or target - current_time > 1:
            self.container.seek(max(0, int(target / self.stream.time_base)), stream=self.stream, backward=True)
            self.iterator = iter(self.container.decode(self.stream))
            self.current = None
        if self.current is not None and abs(float(self.current.time) - target) <= 0.51 / fps:
            return self.current.to_image()
        for decoded in self.iterator:
            self.current = decoded
            if float(decoded.time) >= target - 0.51 / fps:
                return decoded.to_image()
        raise ValueError(f'视频不足以读取目标时间 {target:.3f}s')

    def close(self):
        self.container.close()
