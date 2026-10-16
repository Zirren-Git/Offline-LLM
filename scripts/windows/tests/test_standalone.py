"""Portable packaging regression checks (not a Windows execution test).
Run: python scripts/windows/tests/test_standalone.py
"""
from pathlib import Path
import importlib.util
import re
import unittest

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location('package_standalone', ROOT / 'scripts/windows/package-standalone.py')
GENERATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GENERATOR)


class StandalonePackagingTests(unittest.TestCase):
    def launchers(self):
        for filename, mode in [('install-build-dependencies.bat', 'dependencies'), ('build-apk.bat', 'build')]:
            data = (ROOT / filename).read_bytes()
            text = data.decode().replace('\r\n', '\n')
            marker = re.search(r'^# === OFFLINE-LLM POWERSHELL PAYLOAD ===\n', text, re.M)
            self.assertIsNotNone(marker)
            yield filename, mode, data, text[:marker.start()], text[marker.end():]

    def test_generated_files_are_current(self):
        for filename, mode, data, _, _ in self.launchers():
            with self.subTest(filename=filename):
                self.assertEqual(GENERATOR.render(mode), data)

    def test_windows_line_endings(self):
        for filename, _, data, _, _ in self.launchers():
            with self.subTest(filename=filename):
                self.assertIn(b'\r\n', data)
                self.assertNotIn(b'\n', data.replace(b'\r\n', b''))

    def test_payload_does_not_load_external_helpers(self):
        helpers = (ROOT / 'scripts/windows/android-sdk-tools.ps1').read_text().rstrip()
        for filename, _, _, _, payload in self.launchers():
            with self.subTest(filename=filename):
                self.assertNotIn(". (Join-Path $PSScriptRoot 'android-sdk-tools.ps1')", payload)
                self.assertIn(helpers, payload)
                self.assertIn('function Resolve-SourceDirectory', payload)
                self.assertIn('function Install-CommandLineTools', payload)

    def test_bootstrap_and_exit_codes(self):
        for filename, mode, _, header, _ in self.launchers():
            with self.subTest(filename=filename):
                self.assertIn('setlocal DisableDelayedExpansion', header)
                self.assertIn(f'set "OFFLINE_LLM_MODE={mode}"', header)
                self.assertIn("(?m)^# === OFFLINE-LLM POWERSHELL PAYLOAD ===\\r?$", header)
                self.assertIn('set "RESULT=%ERRORLEVEL%"', header)
                self.assertIn('endlocal & exit /b %RESULT%', header)
                self.assertLess(max(map(len, header.splitlines())), 8191)
                self.assertNotIn('goto missing_helper', header)

    def test_new_version_diagnostics_and_bounded_retries(self):
        for filename, _, _, header, payload in self.launchers():
            with self.subTest(filename=filename):
                self.assertIn(GENERATOR.VERSION, header)
                self.assertIn(GENERATOR.VERSION, payload)
                self.assertIn('Start-Transcript', payload)
                self.assertIn('$_.ScriptStackTrace', payload)
                self.assertIn('$attempt -le 3', payload)
                self.assertIn('-TimeoutSec 300', payload)
                self.assertNotIn('Expand-Archive -LiteralPath', payload)
                self.assertNotIn('Move-Item -LiteralPath $source', payload)

    def test_no_source_download_or_embedded_credentials(self):
        # The repo is private. Source selection must not need authentication or
        # silently fetch mutable remote installer code.
        for filename, _, _, header, payload in self.launchers():
            with self.subTest(filename=filename):
                self.assertNotIn('GH_TOKEN', header + payload)
                self.assertNotIn('GITHUB_TOKEN', header + payload)
                self.assertNotIn('Invoke-Expression', header + payload)
                self.assertNotIn('raw.githubusercontent.com', header + payload)
                self.assertIn('OFFLINE_LLM_SOURCE_DIR', payload)
                self.assertIn('source-path.txt', payload)


if __name__ == '__main__':
    unittest.main(verbosity=2)
