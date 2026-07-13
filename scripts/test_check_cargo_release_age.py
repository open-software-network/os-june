"""Regression tests for check-cargo-release-age.py."""

import importlib.util
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).with_name("check-cargo-release-age.py")
SPEC = importlib.util.spec_from_file_location("check_cargo_release_age", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class CheckCargoReleaseAgeTests(unittest.TestCase):
    def test_checks_every_manifest_with_locked_metadata(self):
        completed = subprocess.CompletedProcess([], 0, stdout="{}", stderr="")
        with patch.object(MODULE.subprocess, "run", return_value=completed) as run:
            count = MODULE.verify_manifests_locked(
                ["june-api/Cargo.toml", "src-tauri/Cargo.toml"]
            )
        self.assertEqual(count, 2)
        self.assertEqual(run.call_count, 2)
        for call in run.call_args_list:
            self.assertIn("--locked", call.args[0])
            self.assertIn("--manifest-path", call.args[0])

    def test_new_manifest_without_lock_fails_closed(self):
        failed = subprocess.CompletedProcess(
            [], 101, stdout="", stderr="the lock file needs to be updated"
        )
        with patch.object(MODULE.subprocess, "run", return_value=failed):
            with self.assertRaisesRegex(
                RuntimeError, "probe/Cargo.toml is not locked"
            ):
                MODULE.verify_manifests_locked(["probe/Cargo.toml"])


if __name__ == "__main__":
    unittest.main()
