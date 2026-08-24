import json
import tempfile
import threading
import unittest
from http.cookiejar import CookieJar
from pathlib import Path
from urllib.request import HTTPCookieProcessor, Request, build_opener

import server


class AnonymousProfilePersistenceTests(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.original_database_path = server.DATABASE_PATH
        self.original_identity_header = server.TRUSTED_IDENTITY_HEADER
        server.DATABASE_PATH = Path(self.temporary_directory.name) / "quiz.db"
        server.TRUSTED_IDENTITY_HEADER = ""
        server.initialise_database()
        self.start_server()

    def tearDown(self):
        self.stop_server()
        server.DATABASE_PATH = self.original_database_path
        server.TRUSTED_IDENTITY_HEADER = self.original_identity_header
        self.temporary_directory.cleanup()

    def start_server(self):
        self.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.QuizHandler)
        self.httpd.daemon_threads = True
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def stop_server(self):
        if getattr(self, "httpd", None):
            self.httpd.shutdown()
            self.httpd.server_close()
            self.thread.join(timeout=3)
            self.httpd = None

    def browser(self):
        jar = CookieJar()
        return build_opener(HTTPCookieProcessor(jar)), jar

    def api(self, opener, path, method="GET", payload=None):
        data = None
        headers = {}
        if payload is not None:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = Request(f"http://127.0.0.1:{self.port}{path}", data=data, headers=headers, method=method)
        with opener.open(request, timeout=5) as response:
            return response.status, json.loads(response.read().decode("utf-8"))

    @staticmethod
    def sample_state(bank_id="bank-a", completed=True):
        question_id = f"{bank_id}::q1"
        return {
            "version": 1,
            "banks": [{
                "id": bank_id,
                "name": "数据库测试题库",
                "filename": "database-test.docx",
                "questions": [{
                    "id": question_id,
                    "sourceId": "q1",
                    "prompt": "SQLite 能否保存题库？",
                    "options": [["A", "可以"], ["B", "不可以"]],
                    "answer": ["A"],
                    "type": "single",
                }],
            }],
            "completed": [question_id] if completed else [],
            "wrong": [],
            "preferences": {"autoNextCorrect": True},
            "lastPractice": {
                "routeKey": f"#/bank/{bank_id}/practice/ordered-single",
                "questionId": question_id,
                "bankId": bank_id,
                "mode": "ordered-single",
                "current": 0,
                "spec": {"bankId": bank_id, "mode": "ordered-single"},
            },
        }

    def test_state_survives_server_restart(self):
        opener, jar = self.browser()
        status, initial = self.api(opener, "/api/state")
        self.assertEqual(status, 200)
        self.assertFalse(initial["hasState"])
        cookie = next(iter(jar))
        self.assertEqual(cookie.name, server.PROFILE_COOKIE_NAME)
        self.assertTrue(cookie.has_nonstandard_attr("HttpOnly"))

        expected = self.sample_state()
        status, saved = self.api(opener, "/api/state", "PUT", {"state": expected})
        self.assertEqual(status, 200)
        self.assertTrue(saved["saved"])
        self.assertEqual(saved["revision"], 1)

        self.stop_server()
        self.start_server()
        status, restored = self.api(opener, "/api/state")
        self.assertEqual(status, 200)
        self.assertTrue(restored["hasState"])
        self.assertEqual(restored["state"], expected)
        self.assertEqual(restored["revision"], 1)

    def test_two_browsers_receive_isolated_profiles(self):
        first, _ = self.browser()
        second, _ = self.browser()
        self.api(first, "/api/state")
        self.api(second, "/api/state")
        self.api(first, "/api/state", "PUT", {"state": self.sample_state("first")})
        self.api(second, "/api/state", "PUT", {"state": self.sample_state("second", completed=False)})

        _, first_state = self.api(first, "/api/state")
        _, second_state = self.api(second, "/api/state")
        self.assertEqual(first_state["state"]["banks"][0]["id"], "first")
        self.assertEqual(second_state["state"]["banks"][0]["id"], "second")
        self.assertNotEqual(first_state["state"], second_state["state"])


if __name__ == "__main__":
    unittest.main()
