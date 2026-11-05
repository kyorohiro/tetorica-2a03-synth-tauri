import importlib.util
from pathlib import Path
import tempfile
import json
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('importer', Path(__file__).resolve().parents[1] / 'scripts/import_release.py')
importer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(importer)


def release_files(text=b'<html>test</html>'):
    files = {
        'index.html': text, 'synth-2a03/index.html': text,
        'synth-2a03/synth.js': b'// readable app', 'synth-2a03/processor.js': b'// processor',
        'synth-2a03/synth.css': b'body {}', 'js/nesapu_wasm.js': b'// readable wrapper',
        'generated/nesapu_wasm.js': b'// generated factory',
        'generated/nesapu_wasm.wasm': b'\x00asm\x01\x00\x00\x00',
        'sources/NES-FDS.md': b'Native sources',
        'sources/scripts/build_nesapu_wasm.sh': b'# native recipe',
        'sources/third_party/tetorica-nes/nes_core.cpp': b'// native core',
        'sources/third_party/tetorica-nes/nes_core.h': b'// native header',
        'sources/wasm/nesapu_wasm.cpp': b'// native wrapper',
        'sources/2a03-synth-browser-inputs.zip': bytes(range(256)),
        'LICENSE': b'BSD-3-Clause', 'licenses/tetorica-nes/LICENSE-JSNES': b'Apache-2.0',
        'licenses/tetorica-nes/LICENSE-FDS': b'MIT', 'licenses/jsnes/LICENSE': b'Apache-2.0',
        'licenses/jsnes/AUTHORS.md': b'JSNES authors', 'licenses/fixnes-fds/LICENSE': b'MIT',
    }
    def record(name):
        return {'path': name, 'bytes': len(files[name]), 'sha256': importer.digest(files[name])}
    entries = ['synth-2a03/synth.js', 'synth-2a03/processor.js', 'synth-2a03/synth.css']
    modules = [{**record(name), 'sourcePath': 'docs/' + name, 'localImports':
                ['../generated/nesapu_wasm.js', '../js/nesapu_wasm.js'] if name.endswith('/processor.js') else []}
               for name in [*entries, 'js/nesapu_wasm.js']]
    files['sources/2a03-synth-browser.json'] = json.dumps({
        'productId': 'tetorica-2a03-synth', 'builder': {'name': 'source-copy', 'minify': False, 'bundle': False},
        'bundles': [record(name) for name in entries], 'modules': modules,
        'originalInputs': [{'path': item['sourcePath'], 'bytes': item['bytes'], 'sha256': item['sha256']} for item in modules],
        'sourceArchive': record('sources/2a03-synth-browser-inputs.zip'),
    }).encode()
    files['sources/NES-FDS.json'] = json.dumps({
        'component': 'nesapu', 'inputs': [record(name) for name in sorted(importer.NATIVE_INPUTS)],
        # NES-FDS generated records do not carry their own path property.
        'generated': {name: {key: value for key, value in record('generated/' + name).items() if key != 'path'}
                      for name in ['nesapu_wasm.js', 'nesapu_wasm.wasm']},
    }).encode()
    return files

def write_archive(path, files):
    with zipfile.ZipFile(path, 'w') as output:
        for name, data in files.items():
            output.writestr(name, data)


class ImportTests(unittest.TestCase):
    def test_new_zip_updates_without_version_and_preserves_label_for_same_zip(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root / 'any-name.zip'
            write_archive(archive, release_files(b'first'))
            first = importer.import_release(root, archive)
            first['version'] = 'named-release'
            (root / 'release.lock.json').write_text(json.dumps(first))
            self.assertEqual(importer.import_release(root, archive)['version'], 'named-release')
            write_archive(archive, release_files(b'second'))
            changed = importer.import_release(root, archive)
            self.assertNotEqual(changed['sha256'], first['sha256'])
            self.assertEqual(changed['version'], 'sha256-' + changed['sha256'][:12])
            self.assertEqual((root / 'dist/index.html').read_text(), 'second')
            self.assertEqual(importer.check(root), changed)

    def test_invalid_replacement_preserves_dist_and_lock(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root / 'release.zip'
            write_archive(archive, release_files(b'valid'))
            first = importer.import_release(root, archive)
            write_archive(archive, {'index.html': b'wrong app'})
            with self.assertRaises(ValueError):
                importer.import_release(root, archive)
            self.assertEqual(importer.check(root), first)
            self.assertEqual((root / 'dist/index.html').read_text(), 'valid')

    def unpack(self, files):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root / 'release.zip'
            write_archive(archive, files)
            return importer.unpack(archive, root / 'out')

    def test_preserves_all_original_bytes(self):
        files = release_files()
        self.assertEqual(self.unpack(files), {name: importer.digest(data) for name, data in files.items()})

    def test_check_detects_modified_or_extra_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'dist').mkdir()
            target = root / 'dist/index.html'
            target.write_bytes(b'original')
            (root / 'release.lock.json').write_text(json.dumps({'version': 'test', 'files': {'index.html': importer.digest(b'original')}}))
            self.assertEqual(importer.check(root)['version'], 'test')
            target.write_bytes(b'changed')
            with self.assertRaises(ValueError): importer.check(root)
            target.write_bytes(b'original')
            (root / 'dist/extra.js').write_bytes(b'extra')
            with self.assertRaises(ValueError): importer.check(root)

    def test_rejects_traversal(self):
        for name in ['../escape', '/absolute', 'a/../../escape', 'a\\escape', 'C:/escape']:
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.unpack({name: b'bad'})

    def test_rejects_wrong_release_or_missing_wasm_and_sources(self):
        with self.assertRaises(ValueError): self.unpack({'index.html': b'wrong app'})
        for name in ['generated/nesapu_wasm.js', 'generated/nesapu_wasm.wasm',
                     'sources/NES-FDS.json', 'sources/2a03-synth-browser-inputs.zip']:
            files = release_files(); del files[name]
            with self.subTest(name=name), self.assertRaises(ValueError): self.unpack(files)

    def test_rejects_mismatched_receipts_and_changed_native_or_browser_bytes(self):
        for name in ['generated/nesapu_wasm.wasm', 'synth-2a03/synth.js',
                     'js/nesapu_wasm.js', 'sources/third_party/tetorica-nes/nes_core.cpp',
                     'sources/2a03-synth-browser-inputs.zip']:
            files = release_files(); files[name] = b'changed'
            with self.subTest(name=name), self.assertRaises(ValueError): self.unpack(files)
        files = release_files()
        receipt = json.loads(files['sources/2a03-synth-browser.json'])
        receipt['productId'] = 'tetorica-spu-synth'
        files['sources/2a03-synth-browser.json'] = json.dumps(receipt).encode()
        with self.assertRaises(ValueError): self.unpack(files)

    def test_every_readable_module_matches_its_live_bytes_and_original_input_record(self):
        files = release_files()
        receipt = json.loads(files['sources/2a03-synth-browser.json'])
        receipt['modules'][-1]['sha256'] = '0' * 64
        files['sources/2a03-synth-browser.json'] = json.dumps(receipt).encode()
        with self.assertRaisesRegex(ValueError, 'receipt mismatch'): self.unpack(files)
        files = release_files()
        receipt = json.loads(files['sources/2a03-synth-browser.json'])
        receipt['originalInputs'][-1]['sha256'] = '0' * 64
        files['sources/2a03-synth-browser.json'] = json.dumps(receipt).encode()
        with self.assertRaisesRegex(ValueError, 'original source'): self.unpack(files)

    def test_readable_module_graph_cannot_omit_a_dependency_or_an_entry(self):
        for omitted in ['js/nesapu_wasm.js', 'synth-2a03/synth.js']:
            files = release_files()
            receipt = json.loads(files['sources/2a03-synth-browser.json'])
            receipt['modules'] = [item for item in receipt['modules'] if item['path'] != omitted]
            files['sources/2a03-synth-browser.json'] = json.dumps(receipt).encode()
            with self.subTest(omitted=omitted), self.assertRaises(ValueError): self.unpack(files)
        files = release_files()
        del files['js/nesapu_wasm.js']
        with self.assertRaisesRegex(ValueError, 'Missing recorded'): self.unpack(files)

    def test_nes_fds_requires_both_license_families_and_complete_native_sources(self):
        for name in ['licenses/tetorica-nes/LICENSE-JSNES', 'licenses/tetorica-nes/LICENSE-FDS',
                     'licenses/jsnes/LICENSE', 'licenses/jsnes/AUTHORS.md', 'licenses/fixnes-fds/LICENSE']:
            files = release_files(); del files[name]
            with self.subTest(name=name), self.assertRaises(ValueError): self.unpack(files)
        files = release_files()
        receipt = json.loads(files['sources/NES-FDS.json'])
        receipt['inputs'] = [item for item in receipt['inputs'] if not item['path'].endswith('nes_core.h')]
        files['sources/NES-FDS.json'] = json.dumps(receipt).encode()
        with self.assertRaisesRegex(ValueError, 'core, wrapper'): self.unpack(files)
        files = release_files()
        receipt = json.loads(files['sources/NES-FDS.json']); receipt['component'] = 'gameboy_apu'
        files['sources/NES-FDS.json'] = json.dumps(receipt).encode()
        with self.assertRaisesRegex(ValueError, 'NES-FDS'): self.unpack(files)

    def test_malformed_or_unsafe_module_records_are_rejected(self):
        for replacement in [[], [None], [{'path': '../escape'}]]:
            files = release_files()
            receipt = json.loads(files['sources/2a03-synth-browser.json']); receipt['modules'] = replacement
            files['sources/2a03-synth-browser.json'] = json.dumps(receipt).encode()
            with self.subTest(replacement=replacement), self.assertRaises(ValueError): self.unpack(files)
        files = release_files()
        receipt = json.loads(files['sources/2a03-synth-browser.json'])
        receipt['modules'][0]['localImports'] = ['../../escape.js']
        files['sources/2a03-synth-browser.json'] = json.dumps(receipt).encode()
        with self.assertRaisesRegex(ValueError, 'Unsafe'): self.unpack(files)

    def test_rejects_duplicate_names_and_symlinks(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); archive = root / 'release.zip'
            with zipfile.ZipFile(archive, 'w') as output:
                output.writestr('index.html', b'a')
                with self.assertWarns(UserWarning): output.writestr('index.html', b'b')
            with self.assertRaisesRegex(ValueError, 'Duplicate'): importer.unpack(archive, root / 'out')
            with zipfile.ZipFile(archive, 'w') as output:
                info = zipfile.ZipInfo('link'); info.create_system = 3
                info.external_attr = 0o120777 << 16
                output.writestr(info, '../../escape')
            with self.assertRaisesRegex(ValueError, 'Unsafe'): importer.unpack(archive, root / 'out2')


if __name__ == '__main__':
    unittest.main()
