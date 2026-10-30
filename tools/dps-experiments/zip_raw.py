"""Package original outputs separately from the public report site."""
import hashlib
import json
from pathlib import Path
import sys
import zipfile

def package(archive):
    source, target = Path(archive['source']), Path(archive['output'])
    if archive.get('sha256'):
        with target.open('rb') as stream:
            checksum = hashlib.file_digest(stream, 'sha256').hexdigest()
        if checksum != archive['sha256']:
            raise ValueError('Packaged archive changed: ' + str(target))
        return [archive]
    target.parent.mkdir(parents=True, exist_ok=True)
    if archive.get('complete'):
        entries = sorted(file for file in source.rglob('*') if file.is_file() and file.suffix.lower() not in ['.exe', '.wasm', '.pending'])
    else:
        entries = [file for folder in ['results', 'debug'] for file in sorted((source / folder).glob('*')) if file.is_file()]
    if not entries:
        raise ValueError('No raw source files: ' + str(source))
    part, output, hashes, receipts = 0, None, {}, []
    limit = archive.get('maxPartBytes', 1024 ** 3) if archive.get('complete') else None

    def finish():
        output.writestr('raw-sha256.json', json.dumps(hashes, indent=2))
        output.close()
        size = part_target.stat().st_size
        if size >= 2 * 1024 ** 3:
            raise ValueError('Raw archive exceeds the release asset limit: ' + str(part_target))
        with part_target.open('rb') as stream:
            checksum = hashlib.file_digest(stream, 'sha256').hexdigest()
        receipts.append({**archive, 'output': str(part_target), 'url': archive['url'].removesuffix('.zip') + (f'-part{part:03}.zip' if limit else '.zip'), 'sha256': checksum, 'bytes': size})
        print(f'{part_target.name}: {size} bytes, {len(hashes)} files', flush=True)

    for file in entries:
        if output is None:
            part += 1
            part_target = target.with_name(target.stem + f'-part{part:03}.zip') if limit else target
            output = zipfile.ZipFile(part_target, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True)
            hashes = {}
        name, checksum = file.relative_to(source).as_posix(), hashlib.sha256()
        with file.open('rb') as original, output.open(name, 'w', force_zip64=True) as stored:
            while chunk := original.read(1024 * 1024):
                checksum.update(chunk)
                stored.write(chunk)
        hashes[name] = checksum.hexdigest()
        if limit and output.fp.tell() >= limit:
            finish()
            output = None
    if output is not None:
        finish()
    return receipts


if __name__ == '__main__':
    config = Path(sys.argv[1])
    archives = json.loads(config.read_text(encoding='utf-8'))
    receipts = [receipt for archive in archives for receipt in package(archive)]
    config.write_text(json.dumps(receipts, indent=2), encoding='utf-8')
