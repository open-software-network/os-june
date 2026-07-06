#!/usr/bin/env python3
"""Tests for the `me` self-reference resolution in os_platform.py."""

import argparse
import unittest

import os_platform


class ResolveMeTokensTest(unittest.TestCase):
    def test_replaces_me_case_insensitively(self):
        self.assertEqual(os_platform.resolve_me_tokens("me", "usr_1"), "usr_1")
        self.assertEqual(os_platform.resolve_me_tokens("ME", "usr_1"), "usr_1")
        self.assertEqual(os_platform.resolve_me_tokens("@me", "usr_1"), "usr_1")

    def test_leaves_other_refs_and_none_untouched(self):
        self.assertEqual(os_platform.resolve_me_tokens("none", "usr_1"), "none")
        self.assertEqual(os_platform.resolve_me_tokens("alice,me", "usr_1"), "alice,usr_1")
        self.assertEqual(os_platform.resolve_me_tokens("alice,bob", "usr_1"), "alice,bob")

    def test_detects_me_token(self):
        self.assertTrue(os_platform.csv_has_me_token("me"))
        self.assertTrue(os_platform.csv_has_me_token("alice, @me"))
        self.assertFalse(os_platform.csv_has_me_token("alice,bob"))
        self.assertFalse(os_platform.csv_has_me_token(None))
        self.assertFalse(os_platform.csv_has_me_token("none"))


class ResolveSelfRefsTest(unittest.TestCase):
    def _stub_request(self):
        calls = []

        def request(method, path, **_kwargs):
            calls.append((method, path))
            return {"success": True, "data": {"public_id": "usr_me", "handle": "caller"}}

        return request, calls

    def test_resolves_assignee_and_creator_with_single_lookup(self):
        args = argparse.Namespace(assignee="me", creator="@me")
        request, calls = self._stub_request()
        os_platform.resolve_self_refs(
            args, base_url="https://x", api_key="k", timeout=5, request=request
        )
        self.assertEqual(args.assignee, "usr_me")
        self.assertEqual(args.creator, "usr_me")
        self.assertEqual(calls, [("GET", "/v1/users/me")])

    def test_no_lookup_when_no_me_token(self):
        args = argparse.Namespace(assignee="alice", creator=None)
        request, calls = self._stub_request()
        os_platform.resolve_self_refs(
            args, base_url="https://x", api_key="k", timeout=5, request=request
        )
        self.assertEqual(args.assignee, "alice")
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
