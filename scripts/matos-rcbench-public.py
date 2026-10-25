"""Public input projection and immutable submission freezing for ResearchClawBench."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import time

def now():
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())

def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f'.{os.getpid()}.tmp')
    tmp.write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n')
    tmp.replace(path)

def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()

def input_manifest(workspace):
    return {str(p.relative_to(workspace)): digest(p)
            for name in ('data', 'related_work')
            for p in sorted((workspace / name).rglob('*')) if p.is_file()}

def verify_case_inputs(workspace, manifest):
    prompt = workspace / 'INSTRUCTIONS.md'
    return {'inputsUnchanged': input_manifest(workspace) == manifest['input_sha256'],
            'promptUnchanged': prompt.is_file() and digest(prompt) == manifest['prompt_sha256']}

def project_task(task, workspace, template, visible_workspace):
    """Allowlist projection; never dereference source symlinks into hidden data."""
    workspace.mkdir(parents=True, exist_ok=False)
    info = json.loads((task / 'task_info.json').read_text())
    for name in ('data', 'related_work'):
        src = task / name
        if not src.exists():
            (workspace / name).mkdir()
            continue
        if src.is_symlink() or any(p.is_symlink() for p in src.rglob('*')):
            raise ValueError(f'symlink in public input: {name}')
        shutil.copytree(src, workspace / name)
    for name in ('code', 'outputs', 'report/images'):
        (workspace / name).mkdir(parents=True)
    data = []
    for d in info.get('data', []):
        kind = f" [{d['type']}]" if d.get('type') else ''
        data.append(f"- **{d['name']}**{kind} (`{d.get('path', '').lstrip('./')}`): {d.get('description', '')}")
    prompt = template.format(workspace=visible_workspace, task_desc=info.get('task', ''),
                             data_text='\n'.join(data) or 'No specific data files.')
    (workspace / 'INSTRUCTIONS.md').write_text(prompt)

def freeze_submission(private, task, workspace):
    """Freeze the actual scorer inputs outside all agent-visible mounts."""
    dst = private / 'submissions' / task
    if dst.exists():
        return
    stage = dst.with_name(task + '.staging')
    if stage.exists():
        raise RuntimeError(f'incomplete submission freeze needs inspection: {task}')
    stage.mkdir(parents=True)
    chosen = [workspace / 'INSTRUCTIONS.md', workspace / '_meta.json']
    for name in ('report', 'code'):
        chosen += sorted((workspace / name).rglob('*'))
    # The upstream scorer reads report text and images only, not raw numeric arrays.
    image_exts = {'.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg'}
    chosen += sorted(p for p in (workspace / 'outputs').rglob('*') if p.suffix.lower() in image_exts)
    hashes = {}
    for p in chosen:
        if p.is_symlink():
            raise RuntimeError(f'submission symlink rejected: {task}/{p.relative_to(workspace)}')
        if not p.is_file():
            continue
        rel = p.relative_to(workspace)
        out = stage / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(p, out)
        hashes[str(rel)] = digest(out)
    write_json(stage / '_submission_manifest.json', {'frozenAt': now(), 'sha256': hashes,
               'nativeTranscriptRoot': str(workspace / '.matos/sessions'),
               'nativeWorkflowRoot': str(workspace / '.matos/workflows/runs'),
               'fullOutputsRoot': str(workspace / 'outputs')})
    stage.replace(dst)
