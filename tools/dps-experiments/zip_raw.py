"""Package original outputs separately from the public report site."""
import hashlib
import json
from pathlib import Path
import sys
import zipfile

config=Path(sys.argv[1])
archives=json.loads(config.read_text(encoding='utf-8'))
for archive in archives:
    source,target=Path(archive['source']),Path(archive['output'])
    target.parent.mkdir(parents=True,exist_ok=True)
    with zipfile.ZipFile(target,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=6,allowZip64=True) as output:
        hashes={}
        for folder in ['results','debug']:
            for file in sorted((source/folder).glob('*')) if (source/folder).exists() else []:
                if file.is_file():
                    name=file.relative_to(source).as_posix()
                    hashes[name]=hashlib.sha256(file.read_bytes()).hexdigest()
                    output.write(file,name)
        output.writestr('raw-sha256.json',json.dumps(hashes,indent=2))
    archive['sha256']=hashlib.sha256(target.read_bytes()).hexdigest()
    archive['bytes']=target.stat().st_size
    print(target.name+': '+str(target.stat().st_size)+' bytes',flush=True)
config.write_text(json.dumps(archives,indent=2),encoding='utf-8')
