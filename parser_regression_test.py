import unittest

import server


class OrdinaryImportParserRegressionTests(unittest.TestCase):
    def parse_one(self, lines):
        questions, warnings = server.parse_docx_questions(lines)
        self.assertEqual(len(questions), 1, warnings)
        return questions[0], warnings

    def test_inline_single_answer_stays_in_stem(self):
        question, _ = self.parse_one([
            "4. 中国共产党在领导社会主义事业中，必须坚持以（ C ）为中心，其他各项工作必须服从和服务于这个中心。",
            "A. 人民",
            "B. 政治建设",
            "C. 经济建设",
            "D. 文化建设",
        ])
        self.assertEqual(
            question["prompt"],
            "中国共产党在领导社会主义事业中，必须坚持以（ ）为中心，其他各项工作必须服从和服务于这个中心。",
        )
        self.assertEqual(question["options"], [["A", "人民"], ["B", "政治建设"], ["C", "经济建设"], ["D", "文化建设"]])
        self.assertEqual(question["answer"], ["C"])
        self.assertEqual(question["type"], "single")

    def test_inline_single_answer_with_compact_dot_options(self):
        question, _ = self.parse_one([
            "4. 中国共产党在领导社会主义事业中，必须坚持以（C）为中心。 A. 人民 B. 政治建设 C. 经济建设 D. 文化建设",
        ])
        self.assertEqual(question["prompt"], "中国共产党在领导社会主义事业中，必须坚持以（ ）为中心。")
        self.assertEqual([key for key, _ in question["options"]], list("ABCD"))
        self.assertEqual(question["answer"], ["C"])

    def test_inline_multi_answer_sets_multi_type(self):
        question, _ = self.parse_one([
            "5. 加强和创新社会治理的措施包括（ A、B、C ）。",
            "A. 完善治理体系",
            "B. 提升治理能力",
            "C. 推进基层治理",
            "D. 取消社会服务",
        ])
        self.assertEqual(question["prompt"], "加强和创新社会治理的措施包括（ ）。")
        self.assertEqual(question["answer"], ["A", "B", "C"])
        self.assertEqual(question["type"], "multi")

    def test_compact_parenthesised_options_do_not_consume_stem_answer(self):
        question, _ = self.parse_one([
            "6. 应当选择（B）。 (A) 选项甲 (B) 选项乙 (C) 选项丙 (D) 选项丁",
        ])
        self.assertEqual(question["prompt"], "应当选择（ ）。")
        self.assertEqual([key for key, _ in question["options"]], list("ABCD"))
        self.assertEqual(question["answer"], ["B"])

    def test_spaced_and_bracketed_answer_payload_is_multi(self):
        question, _ = self.parse_one([
            "7. 下列说法正确的是（ ）。",
            "A. 甲",
            "B. 乙",
            "C. 丙",
            "D. 丁",
            "答案：（A）（C） D",
        ])
        self.assertEqual(question["answer"], ["A", "C", "D"])
        self.assertEqual(question["type"], "multi")

    def test_english_explanation_after_answer_does_not_add_letters(self):
        question, _ = self.parse_one([
            "10. 普通识别不应读取英文说明中的字母。",
            "A. 正确",
            "B. 错误",
            "答案：A because B is wrong",
        ])
        self.assertEqual(question["answer"], ["A"])
        self.assertEqual(question["type"], "single")

    def test_multi_section_is_fallback_when_answer_missing(self):
        questions, warnings = server.parse_docx_questions([
            "二、多项选择题（共1题）",
            "8. 下列说法正确的是（ ）。",
            "A. 甲",
            "B. 乙",
            "C. 丙",
            "D. 丁",
        ])
        self.assertEqual(len(questions), 1, warnings)
        self.assertEqual(questions[0]["answer"], [])
        self.assertEqual(questions[0]["type"], "multi")

    def test_historical_duplicate_option_artifact_is_repaired(self):
        question, warnings = self.parse_one([
            "9. 中国共产党在领导社会主义事业中，必须坚持以（",
            "C）为中心，其他各项工作必须服从和服务于这个中心。",
            "A. 人民",
            "B. 政治建设",
            "C. 经济建设",
            "D. 文化建设",
        ])
        self.assertEqual(question["answer"], ["C"])
        self.assertEqual(question["options"][2], ["C", "经济建设"])
        self.assertIn("为中心", question["prompt"])
        self.assertTrue(any("恢复到题干" in warning for warning in warnings))

    def test_numeric_d_option_glued_to_c_is_split(self):
        question, warnings = self.parse_one([
            "25. 我国提前（C）年，实现联合国2030年可持续发展议程减贫目标。",
            "A. 10",
            "B. 11",
            "C. 12 D15",
        ])
        self.assertEqual(question["options"], [["A", "10"], ["B", "11"], ["C", "12"], ["D", "15"]])
        self.assertEqual(question["answer"], ["C"])
        self.assertTrue(any("粘连" in warning for warning in warnings))

    def test_all_compact_numeric_options_are_split(self):
        for option_line in ("A.10B.11C.12D.15", "A10 B11 C12 D15"):
            with self.subTest(option_line=option_line):
                question, _ = self.parse_one([
                    "26. 下列数字正确的是（D）。",
                    option_line,
                ])
                self.assertEqual(question["options"], [["A", "10"], ["B", "11"], ["C", "12"], ["D", "15"]])
                self.assertEqual(question["answer"], ["D"])

    def test_vitamin_d3_is_not_treated_as_d_option(self):
        question, _ = self.parse_one([
            "27. 下列物质正确的是（C）。",
            "A. 维生素 A",
            "B. 维生素 B12",
            "C. 维生素 D3",
        ])
        self.assertEqual(question["options"], [["A", "维生素 A"], ["B", "维生素 B12"], ["C", "维生素 D3"]])

    def test_ai_explanation_accepts_a_correct_user_answer(self):
        sources = server.prepare_explanation_sources([{
            "sourceId": "question-1",
            "prompt": "党的哪次会议首次提出以人民为中心的发展思想？",
            "options": [{"key": "A", "text": "十八届五中全会"}, {"key": "B", "text": "十九大"}],
            "answer": ["A"],
            "userAnswer": ["A"],
        }])
        self.assertEqual(sources[0]["answer"], ["A"])
        self.assertEqual(sources[0]["userAnswer"], ["A"])

    def test_ai_import_and_explanation_rate_limits_are_separate(self):
        server.AI_RATE_RECORDS.clear()
        self.assertTrue(server.consume_ai_rate_limit("127.0.0.1", "imports", 1))
        self.assertFalse(server.consume_ai_rate_limit("127.0.0.1", "imports", 1))
        self.assertTrue(server.consume_ai_rate_limit("127.0.0.1", "explanations", 1))


if __name__ == "__main__":
    unittest.main()
