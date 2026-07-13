"""Regression tests for check-pnpm-release-age.py."""

import datetime
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("check-pnpm-release-age.py")
SPEC = importlib.util.spec_from_file_location("check_pnpm_release_age", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class CheckPnpmReleaseAgeTests(unittest.TestCase):
    def test_reads_exact_pnpm_pin(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            package_json = Path(temp_dir) / "package.json"
            package_json.write_text(json.dumps({"packageManager": "pnpm@11.9.0"}))
            self.assertEqual(MODULE.pinned_version(package_json), "11.9.0")

    def test_rejects_version_ranges(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            package_json = Path(temp_dir) / "package.json"
            package_json.write_text(json.dumps({"packageManager": "pnpm@^11.9.0"}))
            with self.assertRaisesRegex(ValueError, "must be exact"):
                MODULE.pinned_version(package_json)

    def test_rejects_release_inside_cooldown(self):
        now = datetime.datetime(2026, 7, 10, tzinfo=datetime.timezone.utc)
        published = now - datetime.timedelta(days=6, hours=23)
        self.assertIn(
            "< 7d cooldown",
            MODULE.release_age_error("11.10.0", published, now, 7),
        )

    def test_accepts_release_at_cooldown_boundary(self):
        now = datetime.datetime(2026, 7, 10, tzinfo=datetime.timezone.utc)
        published = now - datetime.timedelta(days=7)
        self.assertIsNone(
            MODULE.release_age_error("11.9.0", published, now, 7)
        )

    def test_missing_publication_time_fails_closed(self):
        with self.assertRaisesRegex(ValueError, "no publication time"):
            MODULE.publication_time({"time": {}}, "11.9.0")


if __name__ == "__main__":
    unittest.main()
