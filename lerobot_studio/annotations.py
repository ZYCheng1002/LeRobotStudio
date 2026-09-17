"""标注只写入 meta/annotation.json，通过原子替换避免半写文件。"""
import json
import os
import tempfile
import threading
from datetime import datetime, timezone


class AnnotationStore:
    def __init__(self, root, labels):
        self.path = root / 'meta/annotation.json'
        self.labels = labels
        self.lock = threading.Lock()

    def read(self):
        if not self.path.exists():
            return {'schema_version': 1, 'episodes': {}}
        data = json.loads(self.path.read_text(encoding='utf-8'))
        if data.get('schema_version') != 1 or not isinstance(data.get('episodes'), dict):
            raise ValueError('annotation.json 格式不受支持，未覆盖原文件')
        return data

    def save(self, episode_id, labels, note, frame):
        if not isinstance(labels, list) or not labels or any(label not in self.labels for label in labels):
            raise ValueError('请选择有效的标注项目')
        if not isinstance(note, str) or len(note) > 4000:
            raise ValueError('备注必须为文本，最多 4000 字')
        if '其他' in labels and not note.strip():
            raise ValueError('选择“其他”后请填写备注')
        with self.lock:
            data = self.read()
            annotation = dict(data['episodes'].get(str(episode_id), {}))
            annotation.update({'episode_index': episode_id, 'labels': list(dict.fromkeys(labels)),
                          'note': note.strip(), 'review_frame': frame,
                          'updated_at': datetime.now(timezone.utc).isoformat()})
            data['episodes'][str(episode_id)] = annotation
            temporary = None
            try:
                with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=self.path.parent,
                                                 prefix='.annotation-', suffix='.tmp', delete=False) as handle:
                    temporary = handle.name
                    json.dump(data, handle, ensure_ascii=False, indent=2)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temporary, self.path)
            finally:
                if temporary and os.path.exists(temporary):
                    os.unlink(temporary)
            return annotation
