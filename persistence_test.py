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

    def sse_api(self, opener, path, payload):
        request = Request(
            f"http://127.0.0.1:{self.port}{path}",
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with opener.open(request, timeout=5) as response:
            return response.status, response.headers.get("Content-Type", ""), response.read().decode("utf-8")

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
            "preferences": {"autoNextCorrect": True, "shuffleOptions": True},
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

    def test_plain_text_bank_import_endpoint(self):
        opener, _ = self.browser()
        boundary = "----tudou-test-boundary"
        file_payload = "1. 接口能否导入文本题库（A）\nA. 可以\nB. 不可以\n".encode("utf-8")
        body = (
            f"--{boundary}\r\n"
            'Content-Disposition: form-data; name="file"; filename="sample.txt"\r\n'
            "Content-Type: text/plain\r\n\r\n"
        ).encode("utf-8") + file_payload + (
            f"\r\n--{boundary}\r\n"
            'Content-Disposition: form-data; name="use_ai"\r\n\r\n'
            "0\r\n"
            f"--{boundary}--\r\n"
        ).encode("utf-8")
        request = Request(
            f"http://127.0.0.1:{self.port}/api/import",
            data=body,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
            method="POST",
        )
        with opener.open(request, timeout=5) as response:
            result = json.loads(response.read().decode("utf-8"))
        self.assertEqual(response.status, 200)
        self.assertEqual(result["bank"]["sourceFormat"], "txt")
        self.assertEqual(result["bank"]["questionCount"], 1)
        self.assertEqual(result["questions"][0]["answer"], ["A"])

    def test_tutor_endpoint_returns_followup_answer(self):
        opener, _ = self.browser()
        original_answer_tutor_question = server.answer_tutor_question
        server.answer_tutor_question = lambda question, explanation, history, message: f"针对追问：{message}"
        try:
            status, result = self.api(opener, "/api/tutor", "POST", {
                "question": {
                    "sourceId": "q1",
                    "prompt": "示例题",
                    "options": [{"key": "A", "text": "正确"}, {"key": "B", "text": "错误"}],
                    "answer": ["A"],
                    "userAnswer": ["B"],
                },
                "explanation": "A 符合定义。",
                "history": [],
                "message": "为什么？",
            })
        finally:
            server.answer_tutor_question = original_answer_tutor_question
        self.assertEqual(status, 200)
        self.assertEqual(result["answer"], "针对追问：为什么？")

    def test_deepseek_stream_ignores_reasoning_and_forwards_markdown(self):
        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *_):
                return False

            def __iter__(self):
                events = [
                    {"choices": [{"delta": {"reasoning_content": "不应转发的内部推理"}, "finish_reason": None}]},
                    {"choices": [{"delta": {"content": "### 结论\n"}, "finish_reason": None}]},
                    {"choices": [{"delta": {"content": "**正确答案：A**"}, "finish_reason": "stop"}]},
                ]
                lines = [f"data: {json.dumps(event, ensure_ascii=False)}\n".encode("utf-8") for event in events]
                lines.append(b"data: [DONE]\n")
                return iter(lines)

        original_urlopen = server.urlopen
        server.urlopen = lambda *_args, **_kwargs: FakeResponse()
        fragments = []
        try:
            answer = server.request_deepseek_stream(
                "test-key",
                [{"role": "user", "content": "测试"}],
                100,
                "测试流",
                fragments.append,
            )
        finally:
            server.urlopen = original_urlopen
        self.assertEqual(answer, "### 结论\n**正确答案：A**")
        self.assertEqual(fragments, ["### 结论\n", "**正确答案：A**"])
        self.assertNotIn("内部推理", answer)

    def test_streaming_explanation_and_tutor_endpoints_emit_sse(self):
        opener, _ = self.browser()
        original_api_key = server.load_deepseek_api_key
        original_explanation = server.stream_question_explanation
        original_tutor = server.stream_tutor_answer

        def fake_explanation(_api_key, _source, on_delta, on_heartbeat=None):
            on_delta("### 结论\n")
            if on_heartbeat:
                on_heartbeat()
            on_delta("**正确答案：A**")
            return "### 结论\n**正确答案：A**"

        def fake_tutor(_api_key, _question, _explanation, _history, _message, on_delta, on_heartbeat=None):
            on_delta("- 第一点\n")
            on_delta("- 第二点")
            return "- 第一点\n- 第二点"

        server.load_deepseek_api_key = lambda: "test-key"
        server.stream_question_explanation = fake_explanation
        server.stream_tutor_answer = fake_tutor
        question = {
            "sourceId": "q1",
            "prompt": "示例题",
            "options": [{"key": "A", "text": "正确"}, {"key": "B", "text": "错误"}],
            "answer": ["A"],
            "userAnswer": ["B"],
        }
        try:
            status, content_type, body = self.sse_api(opener, "/api/explanations/stream", {"questions": [question]})
            tutor_status, tutor_content_type, tutor_body = self.sse_api(opener, "/api/tutor/stream", {
                "question": question,
                "explanation": "A 符合定义。",
                "history": [],
                "message": "为什么？",
            })
        finally:
            server.load_deepseek_api_key = original_api_key
            server.stream_question_explanation = original_explanation
            server.stream_tutor_answer = original_tutor

        self.assertEqual(status, 200)
        self.assertTrue(content_type.startswith("text/event-stream"))
        self.assertIn("event: meta", body)
        self.assertEqual(body.count("event: delta"), 2)
        self.assertIn("event: heartbeat", body)
        self.assertIn("event: item_done", body)
        self.assertIn("event: done", body)
        self.assertIn("### 结论", body)

        self.assertEqual(tutor_status, 200)
        self.assertTrue(tutor_content_type.startswith("text/event-stream"))
        self.assertEqual(tutor_body.count("event: delta"), 2)
        self.assertIn("event: done", tutor_body)


if __name__ == "__main__":
    unittest.main()
