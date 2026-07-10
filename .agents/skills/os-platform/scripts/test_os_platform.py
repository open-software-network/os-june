#!/usr/bin/env python3
"""Unit tests for os_platform.py without live API writes."""

import argparse
import contextlib
import io
import json
import pathlib
import subprocess
import tempfile
import unittest
from unittest import mock

import os_platform


BASE_URL = "https://platform.test/api"
API_KEY = "secret"
TIMEOUT = 5


def envelope(data):
    return {"success": True, "data": data}


def issue(assignee_user_id=None, **overrides):
    value = {
        "external_id": "JUN-250",
        "title": "Align platform writes",
        "status": "todo",
        "assignee_user_id": assignee_user_id,
        "assignee": None,
        "files": [],
    }
    value.update(overrides)
    return value


def current_user():
    return {"public_id": "usr_me", "handle": "caller"}


class FakeRequest:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, method, path, **kwargs):
        self.calls.append({"method": method, "path": path, **kwargs})
        if not self.responses:
            raise AssertionError(f"unexpected request: {method} {path}")
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response

    def assert_exhausted(self, test_case):
        test_case.assertEqual(self.responses, [])


def assign_with(request, *, force=False):
    return os_platform.assign_issue_to_current_user(
        "june",
        "250",
        base_url=BASE_URL,
        api_key=API_KEY,
        timeout=TIMEOUT,
        force=force,
        request=request,
    )


def set_status_with(request, status="in_review", *, force=False, assume_yes=False):
    return os_platform.set_issue_status(
        "june",
        "250",
        status,
        base_url=BASE_URL,
        api_key=API_KEY,
        timeout=TIMEOUT,
        force=force,
        assume_yes=assume_yes,
        request=request,
    )


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
    def test_resolves_assignee_and_creator_with_single_lookup(self):
        args = argparse.Namespace(assignee="me", creator="@me")
        request = FakeRequest(envelope(current_user()))
        os_platform.resolve_self_refs(
            args, base_url=BASE_URL, api_key=API_KEY, timeout=TIMEOUT, request=request
        )
        self.assertEqual(args.assignee, "usr_me")
        self.assertEqual(args.creator, "usr_me")
        self.assertEqual(
            [(call["method"], call["path"]) for call in request.calls],
            [("GET", "/v1/users/me")],
        )

    def test_no_lookup_when_no_me_token(self):
        args = argparse.Namespace(assignee="alice", creator=None)
        request = FakeRequest()
        os_platform.resolve_self_refs(
            args, base_url=BASE_URL, api_key=API_KEY, timeout=TIMEOUT, request=request
        )
        self.assertEqual(args.assignee, "alice")
        self.assertEqual(request.calls, [])


class AssignIssueTest(unittest.TestCase):
    def test_assigns_unassigned_issue_and_verifies(self):
        verified = issue("usr_me", assignee={"id": "usr_me", "handle": "caller"})
        request = FakeRequest(
            envelope(issue()),
            envelope(current_user()),
            envelope(verified),
            envelope(verified),
        )

        result = assign_with(request)

        self.assertEqual(result, verified)
        self.assertEqual([call["method"] for call in request.calls], ["GET", "GET", "PATCH", "GET"])
        self.assertEqual(request.calls[2]["body"], {"assignee_user_id": "usr_me"})
        request.assert_exhausted(self)

    def test_self_assigned_uses_assignee_user_id_and_skips_patch(self):
        owned = issue("usr_me", assignee={"id": "unrelated_sparse_id"})
        request = FakeRequest(envelope(owned), envelope(current_user()))

        self.assertEqual(assign_with(request), owned)
        self.assertEqual([call["method"] for call in request.calls], ["GET", "GET"])
        request.assert_exhausted(self)

    def test_refuses_issue_assigned_to_another_user(self):
        foreign = issue("usr_other", assignee={"id": "usr_other", "handle": "alice"})
        request = FakeRequest(envelope(foreign), envelope(current_user()))

        with self.assertRaisesRegex(os_platform.OsPlatformError, "alice.*--force"):
            assign_with(request)

        self.assertEqual([call["method"] for call in request.calls], ["GET", "GET"])
        request.assert_exhausted(self)

    def test_force_replaces_another_assignee_and_verifies(self):
        foreign = issue("usr_other", assignee={"id": "usr_other", "handle": "alice"})
        verified = issue("usr_me", assignee={"id": "usr_me", "handle": "caller"})
        request = FakeRequest(
            envelope(foreign),
            envelope(current_user()),
            envelope(verified),
            envelope(verified),
        )

        result = assign_with(request, force=True)

        self.assertEqual(result, verified)
        self.assertEqual(request.calls[2]["body"], {"assignee_user_id": "usr_me"})
        request.assert_exhausted(self)

    def test_sparse_assignee_object_without_id_is_unassigned(self):
        sparse = issue(assignee={"handle": "stale-display-only"})
        sparse.pop("assignee_user_id")
        verified = issue("usr_me")
        request = FakeRequest(
            envelope(sparse),
            envelope(current_user()),
            envelope(verified),
            envelope(verified),
        )

        self.assertEqual(assign_with(request), verified)
        self.assertEqual(request.calls[2]["body"], {"assignee_user_id": "usr_me"})
        request.assert_exhausted(self)

    def test_fails_when_post_write_verification_observes_race(self):
        request = FakeRequest(
            envelope(issue()),
            envelope(current_user()),
            envelope(issue("usr_me")),
            envelope(issue("usr_racer")),
        )

        with self.assertRaisesRegex(os_platform.OsPlatformError, "verification failed.*raced"):
            assign_with(request)

        self.assertEqual([call["method"] for call in request.calls], ["GET", "GET", "PATCH", "GET"])
        request.assert_exhausted(self)


class StatusGuardTest(unittest.TestCase):
    def test_owned_issue_changes_status_and_prints_context(self):
        updated = issue("usr_me", status="in_review")
        request = FakeRequest(
            envelope(issue("usr_me")),
            envelope(current_user()),
            envelope(updated),
        )
        stderr = io.StringIO()

        with contextlib.redirect_stderr(stderr):
            result = set_status_with(request)

        self.assertEqual(result, updated)
        self.assertIn("JUN-250", stderr.getvalue())
        self.assertIn("Align platform writes", stderr.getvalue())
        self.assertIn("current status: todo", stderr.getvalue())
        self.assertEqual(request.calls[2]["method"], "POST")
        self.assertEqual(request.calls[2]["path"], "/v1/orgs/june/bounties/250/status")
        self.assertEqual(request.calls[2]["body"], {"status": "in_review"})
        request.assert_exhausted(self)

    def test_refuses_foreign_issue_without_force(self):
        foreign = issue("usr_other", assignee={"id": "usr_other", "handle": "alice"})
        request = FakeRequest(envelope(foreign), envelope(current_user()))

        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaisesRegex(os_platform.OsPlatformError, "alice.*--force"):
                set_status_with(request)

        self.assertEqual([call["method"] for call in request.calls], ["GET", "GET"])
        request.assert_exhausted(self)

    def test_force_allows_foreign_issue_status_change(self):
        foreign = issue("usr_other", assignee={"id": "usr_other", "handle": "alice"})
        updated = dict(foreign, status="in_review")
        request = FakeRequest(envelope(foreign), envelope(current_user()), envelope(updated))

        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(set_status_with(request, force=True), updated)

        self.assertEqual(request.calls[2]["body"], {"status": "in_review"})
        request.assert_exhausted(self)

    def test_terminal_status_without_yes_prints_would_change_and_refuses(self):
        request = FakeRequest(envelope(issue("usr_me")), envelope(current_user()))
        stderr = io.StringIO()

        with contextlib.redirect_stderr(stderr):
            with self.assertRaisesRegex(os_platform.OsPlatformError, "require --yes"):
                set_status_with(request, "completed")

        self.assertIn("WOULD change JUN-250 from todo to completed", stderr.getvalue())
        self.assertEqual([call["method"] for call in request.calls], ["GET", "GET"])
        request.assert_exhausted(self)

    def test_terminal_status_with_yes_posts(self):
        completed = issue("usr_me", status="completed")
        request = FakeRequest(
            envelope(issue("usr_me")),
            envelope(current_user()),
            envelope(completed),
        )

        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(set_status_with(request, "completed", assume_yes=True), completed)

        self.assertEqual(request.calls[2]["body"], {"status": "completed"})
        request.assert_exhausted(self)


class RequestShapeTest(unittest.TestCase):
    def test_create_shape_uses_contract_fields(self):
        request = FakeRequest(envelope(issue()))

        os_platform.send_write_request(
            os_platform.issue_create_request("june", "Title", "Body", "bug", "urgent"),
            base_url=BASE_URL,
            api_key=API_KEY,
            timeout=TIMEOUT,
            request=request,
        )

        self.assertEqual(request.calls[0]["method"], "POST")
        self.assertEqual(request.calls[0]["path"], "/v1/orgs/june/bounties")
        self.assertEqual(
            request.calls[0]["body"],
            {
                "title": "Title",
                "body_markdown": "Body",
                "type": "bug",
                "priority": "urgent",
            },
        )
        request.assert_exhausted(self)

    def test_comment_shape_uses_body_markdown(self):
        request = FakeRequest(envelope({"id": "cmt_1"}))

        os_platform.send_write_request(
            os_platform.comment_create_request("june", "250", "PR opened"),
            base_url=BASE_URL,
            api_key=API_KEY,
            timeout=TIMEOUT,
            request=request,
        )

        self.assertEqual(request.calls[0]["method"], "POST")
        self.assertEqual(request.calls[0]["path"], "/v1/orgs/june/bounties/250/comments")
        self.assertEqual(request.calls[0]["body"], {"body_markdown": "PR opened"})
        request.assert_exhausted(self)

    def test_attach_preserves_existing_file_ids(self):
        initial = issue(files=[{"id": "fil_old_1"}, {"id": "fil_old_2"}])
        updated = issue(files=[{"id": "fil_old_1"}, {"id": "fil_old_2"}, {"id": "fil_new"}])
        request = FakeRequest(envelope(initial), envelope(updated))

        result = os_platform.attach_file_to_issue(
            "june",
            "250",
            "fil_new",
            base_url=BASE_URL,
            api_key=API_KEY,
            timeout=TIMEOUT,
            request=request,
        )

        self.assertEqual(result, updated)
        self.assertEqual([call["method"] for call in request.calls], ["GET", "PATCH"])
        self.assertEqual(
            request.calls[1]["body"],
            {"file_ids": ["fil_old_1", "fil_old_2", "fil_new"]},
        )
        request.assert_exhausted(self)

    def test_file_upload_uses_contract_multipart_fields(self):
        captured = {}

        def run(command, **kwargs):
            captured["command"] = command
            captured.update(kwargs)
            return subprocess.CompletedProcess(
                command,
                0,
                stdout=json.dumps(envelope({"id": "fil_new", "purpose": "attachment"})),
                stderr="",
            )

        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "evidence.mp4"
            path.write_bytes(b"video")
            result = os_platform.upload_file(
                path,
                is_public=True,
                purpose="attachment",
                base_url=BASE_URL,
                api_key=API_KEY,
                timeout=TIMEOUT,
                run=run,
            )

        self.assertEqual(result["id"], "fil_new")
        self.assertIn("https://platform.test/api/v1/files", captured["command"])
        forms = [
            captured["command"][index + 1]
            for index, value in enumerate(captured["command"])
            if value == "-F"
        ]
        self.assertTrue(forms[0].startswith("file=@"))
        self.assertIn("type=video/mp4", forms[0])
        self.assertIn("filename=evidence.mp4", forms[0])
        self.assertEqual(forms[1:], ["is_public=true", "purpose=attachment"])
        self.assertIn("Authorization: Bearer secret", captured["input"])
        self.assertNotIn(API_KEY, captured["command"])

    def test_attach_path_uploads_privately_before_attach(self):
        argv = [
            "issues",
            "attach",
            "june",
            "250",
            "--path",
            "/tmp/evidence.mp4",
            "--api-key",
            API_KEY,
        ]
        with mock.patch.object(os_platform, "load_project_config", return_value={}):
            with mock.patch.object(
                os_platform, "upload_file", return_value={"id": "fil_uploaded"}
            ) as upload:
                with mock.patch.object(
                    os_platform,
                    "attach_file_to_issue",
                    return_value=issue(files=[{"id": "fil_uploaded"}]),
                ) as attach:
                    with contextlib.redirect_stdout(io.StringIO()):
                        self.assertEqual(os_platform.main(argv), 0)

        self.assertEqual(upload.call_args.args, ("/tmp/evidence.mp4",))
        self.assertFalse(upload.call_args.kwargs["is_public"])
        self.assertEqual(upload.call_args.kwargs["purpose"], "attachment")
        self.assertEqual(attach.call_args.args, ("june", "250", "fil_uploaded"))


class ParserAndErrorTest(unittest.TestCase):
    def test_status_accepts_proposed(self):
        args = os_platform.build_parser().parse_args(["issues", "status", "june", "250", "proposed"])
        self.assertEqual(args.status, "proposed")

    def test_file_upload_defaults_to_private_attachment(self):
        args = os_platform.build_parser().parse_args(["files", "upload", "evidence.mp4"])
        self.assertFalse(args.is_public)
        self.assertEqual(args.purpose, "attachment")

    def assert_missing_number(self, argv):
        stderr = io.StringIO()
        with mock.patch.object(os_platform, "load_project_config", return_value={}):
            with contextlib.redirect_stderr(stderr):
                with self.assertRaises(SystemExit) as raised:
                    os_platform.main([*argv, "--api-key", API_KEY])

        self.assertEqual(raised.exception.code, 2)
        self.assertIn("issue number is required", stderr.getvalue())
        self.assertNotIn("AttributeError", stderr.getvalue())
        self.assertNotIn("Traceback", stderr.getvalue())

    def test_assign_missing_number_is_clean_error(self):
        self.assert_missing_number(["issues", "assign", "june"])

    def test_status_missing_number_is_clean_error(self):
        self.assert_missing_number(["issues", "status", "june", "in_review"])

    def test_comment_missing_number_is_clean_error(self):
        self.assert_missing_number(["comments", "add", "june", "--body", "Update"])


if __name__ == "__main__":
    unittest.main()
