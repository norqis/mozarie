"""Regression contracts for the native Explorer-style output-folder picker."""

from __future__ import annotations

import ast
import base64
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
HTTP_PATH = ROOT / "mozarie" / "http.py"
LEGACY_FOLDER_APIS = (
    "FolderBrowserDialog",
    "SHBrowseForFolder",
    "SHBrowseForFolderA",
    "SHBrowseForFolderW",
)
EXECUTABLE_SUFFIXES = {".bat", ".cmd", ".cjs", ".cs", ".html", ".htm", ".js", ".mjs", ".ps1", ".psm1", ".py", ".vbs", ".xaml"}
EXCLUDED_DIRECTORIES = {".git", ".venv", ".venv-test", "__pycache__", "docs", "node_modules", "tests"}


def output_picker_script() -> str:
    tree = ast.parse(HTTP_PATH.read_text(encoding="utf-8"))
    function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "_pick_output_directory")
    assignment = next(
        node for node in function.body
        if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "script" for target in node.targets)
    )
    return ast.literal_eval(assignment.value)


def production_sources() -> list[Path]:
    sources: list[Path] = []
    for directory, children, filenames in os.walk(ROOT):
        children[:] = sorted(name for name in children if name not in EXCLUDED_DIRECTORIES)
        sources.extend(
            Path(directory) / filename for filename in sorted(filenames)
            if Path(filename).suffix.lower() in EXECUTABLE_SUFFIXES
        )
    return sources


class NativeFolderPickerTests(unittest.TestCase):
    def test_production_code_never_reintroduces_legacy_folder_apis(self) -> None:
        offenders: list[str] = []
        for path in production_sources():
            text = path.read_text(encoding="utf-8", errors="replace").casefold()
            for api in LEGACY_FOLDER_APIS:
                if api.casefold() in text:
                    offenders.append(f"{path.relative_to(ROOT)}: {api}")
        self.assertEqual(offenders, [])

    def test_three_output_entry_points_share_the_one_native_picker_route(self) -> None:
        save_source = (ROOT / "static" / "js" / "save.js").read_text(encoding="utf-8")
        settings_source = (ROOT / "static" / "js" / "settings.js").read_text(encoding="utf-8")
        for source, entry_point in (
            (settings_source, "chooseSettingsOutputDirectory"),
            (save_source, "chooseSingleOutputDirectory"),
            (save_source, "chooseOutputDirectory"),
        ):
            start = source.index(f"async function {entry_point}()")
            body = source[start:source.index("\n}\n", start) + 3]
            self.assertIn("pickOutputDirectory()", body)
        self.assertEqual(save_source.count('api("/api/output-directory/pick"'), 1)
        http_source = HTTP_PATH.read_text(encoding="utf-8")
        self.assertEqual(http_source.count('elif path == "/api/output-directory/pick":'), 1)
        self.assertEqual(http_source.count("def _pick_output_directory("), 1)

    def test_common_item_dialog_contract_has_folder_options_owner_cancel_and_result(self) -> None:
        script = output_picker_script()
        self.assertIn("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7", script)
        self.assertIn("internal interface IFileDialog", script)
        self.assertIn("public static class NativeFolderPicker", script)
        self.assertIn("FOS_PICKFOLDERS = 0x00000020", script)
        self.assertIn("FOS_FORCEFILESYSTEM = 0x00000040", script)
        self.assertIn("FOS_PATHMUSTEXIST = 0x00000800", script)
        self.assertIn("FOS_NOCHANGEDIR = 0x00000008", script)
        self.assertLess(script.index("GetOptions(out options)"), script.index("SetOptions(options |"))
        self.assertIn("SHCreateItemFromParsingName", script)
        self.assertIn("dialog.SetFolder(initial)", script)
        self.assertIn("dialog.Show(owner)", script)
        self.assertIn("ERROR_CANCELLED", script)
        self.assertIn("dialog.GetResult(out selected)", script)
        self.assertIn("selected.GetDisplayName(SIGDN_FILESYSPATH, out path)", script)
        self.assertIn("[Mozarie.NativeFolderPicker]::PickFolder($owner.Handle, $initial)", script)
        self.assertIn("exit 1", script)

    def test_compiled_product_interop_sets_folder_options_without_showing_a_dialog(self) -> None:
        script = output_picker_script()
        csharp_start = script.index('Add-Type -TypeDefinition @"') + len('Add-Type -TypeDefinition @"')
        csharp_end = script.index('\n"@\n$owner', csharp_start)
        csharp = script[csharp_start:csharp_end]
        probe = f'''$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
{csharp}
"@
$dialog = $null
$initial = $null
try {{
  $assembly = [Mozarie.NativeFolderPicker].Assembly
  $fileDialogType = $assembly.GetType('Mozarie.IFileDialog', $true)
  $shellItemType = $assembly.GetType('Mozarie.IShellItem', $true)
  $pickerType = $assembly.GetType('Mozarie.NativeFolderPicker', $true)
  if ($null -eq [Mozarie.NativeFolderPicker].GetMethod('PickFolder', [Reflection.BindingFlags]'Public, Static')) {{ throw 'PickFolder was not exported' }}
  $dialog = [Activator]::CreateInstance([type]::GetTypeFromCLSID([Guid]'DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7'))
  $getOptions = $fileDialogType.GetMethod('GetOptions')
  $setOptions = $fileDialogType.GetMethod('SetOptions')
  $setFolder = $fileDialogType.GetMethod('SetFolder')
  $getArguments = [object[]]@([uint32]0)
  if ([int]$getOptions.Invoke($dialog, $getArguments) -ne 0) {{ throw 'GetOptions failed' }}
  [uint32]$options = $getArguments[0]
  [uint32]$folderOptions = 0x00000008 -bor 0x00000020 -bor 0x00000040 -bor 0x00000800
  if ([int]$setOptions.Invoke($dialog, [object[]]@([uint32]($options -bor $folderOptions))) -ne 0) {{ throw 'SetOptions failed' }}
  $updatedArguments = [object[]]@([uint32]0)
  if ([int]$getOptions.Invoke($dialog, $updatedArguments) -ne 0 -or (([uint32]$updatedArguments[0] -band $folderOptions) -ne $folderOptions)) {{ throw 'Folder options were not retained' }}
  $method = $pickerType.GetMethod('SHCreateItemFromParsingName', [Reflection.BindingFlags]'NonPublic, Static')
  $arguments = [object[]]@($env:MOZARIE_NATIVE_PICKER_TEST_DIRECTORY, [IntPtr]::Zero, $shellItemType.GUID, $null)
  if ([int]$method.Invoke($null, $arguments) -ne 0) {{ throw 'SHCreateItemFromParsingName failed' }}
  $initial = $arguments[3]
  if ([int]$setFolder.Invoke($dialog, [object[]]@($initial)) -ne 0) {{ throw 'SetFolder failed' }}
}} finally {{
  if ($null -ne $initial) {{ [void][Runtime.InteropServices.Marshal]::ReleaseComObject($initial) }}
  if ($null -ne $dialog) {{ [void][Runtime.InteropServices.Marshal]::ReleaseComObject($dialog) }}
}}
'''
        executable = Path(os.environ.get("SystemRoot", r"C:\\Windows")) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
        self.assertTrue(executable.is_file(), executable)
        with tempfile.TemporaryDirectory() as directory:
            environment = os.environ.copy()
            environment["MOZARIE_NATIVE_PICKER_TEST_DIRECTORY"] = str(Path(directory).resolve())
            encoded = base64.b64encode(probe.encode("utf-16le")).decode("ascii")
            completed = subprocess.run(
                [str(executable), "-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", encoded],
                check=False, capture_output=True, text=True, encoding="utf-8", errors="replace", env=environment, timeout=30,
            )
        self.assertEqual(completed.returncode, 0, f"{completed.stdout}\n{completed.stderr}")


if __name__ == "__main__":
    unittest.main()
