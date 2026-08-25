import unittest
from io import BytesIO
from zipfile import ZipFile

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

    def test_missing_b_key_glued_to_a_is_recovered_from_later_keys(self):
        question, warnings = self.parse_one([
            "69. 共建“一带一路”，秉持（C）原则。",
            "A.全面开放B.互利共赢",
            "C.共商共建共享",
            "D.引进来和走出去并重",
        ])
        self.assertEqual(question["prompt"], "共建“一带一路”，秉持（ ）原则。")
        self.assertEqual(question["options"], [
            ["A", "全面开放"],
            ["B", "互利共赢"],
            ["C", "共商共建共享"],
            ["D", "引进来和走出去并重"],
        ])
        self.assertEqual(question["answer"], ["C"])
        self.assertTrue(any("B 选项自动拆开" in warning for warning in warnings))

    def test_bare_option_label_keeps_wrapped_text_out_of_prompt(self):
        question, warnings = self.parse_one([
            "22、王某丢失手表，下列说法正确的有（ ）。",
            "A、",
            "自招领公告发布之日起一年内无人认领的，遗失物归国家所有",
            "B、该手表属于孙某",
            "C、该手表属于林某",
            "D、郑某善意取得该手表",
            "答案：AC",
        ])
        self.assertEqual(question["prompt"], "王某丢失手表，下列说法正确的有（ ）。")
        self.assertEqual(question["options"][0], ["A", "自招领公告发布之日起一年内无人认领的，遗失物归国家所有"])
        self.assertEqual([key for key, _ in question["options"]], list("ABCD"))
        self.assertEqual(question["answer"], ["A", "C"])
        self.assertFalse(any("没有对应选项" in warning for warning in warnings))

    def test_bare_last_option_label_does_not_merge_into_previous_option(self):
        question, warnings = self.parse_one([
            "59、治安管理处罚决定书应包括哪些内容（ ）。",
            "A、被处罚人信息",
            "B、违法事实和证据",
            "C、救济途径和期限",
            "D、",
            "作出处罚决定的公安机关名称和日期",
            "答案：ABCD",
        ])
        self.assertEqual(question["options"][2], ["C", "救济途径和期限"])
        self.assertEqual(question["options"][3], ["D", "作出处罚决定的公安机关名称和日期"])
        self.assertEqual(question["answer"], list("ABCD"))
        self.assertEqual(question["type"], "multi")
        self.assertFalse(any("没有对应选项" in warning for warning in warnings))

    def test_wrapped_chinese_and_number_fragments_do_not_gain_spaces(self):
        question, _ = self.parse_one([
            "60、甲将100万元现金退还后,又揭发了同案",
            "犯乙的犯罪事实。对甲应当（A）。",
            "A、可以从轻或者减轻处罚",
            "B、应当从重处罚",
            "C、免除处罚",
            "D、维持原处罚",
        ])
        self.assertIn("100万元", question["prompt"])
        self.assertIn("同案犯乙", question["prompt"])
        self.assertNotIn("1 00", question["prompt"])
        self.assertNotIn("同案 犯", question["prompt"])

    def test_wrapped_latin_words_keep_a_separator(self):
        self.assertEqual(server.join_wrapped_text("supports legacy", "Word files"), "supports legacy Word files")

    def test_bare_a_option_at_end_of_stem_and_bare_following_options_are_recovered(self):
        question, warnings = self.parse_one([
            "54. 要坚持把（C）作为党的奋斗目标。 A促进人的全面发展",
            "B促进人的生活水平提高",
            "C人民对美好生活的向往",
            "D促进人的自由发展",
        ])
        self.assertEqual(question["prompt"], "要坚持把（ ）作为党的奋斗目标。")
        self.assertEqual(question["options"], [
            ["A", "促进人的全面发展"],
            ["B", "促进人的生活水平提高"],
            ["C", "人民对美好生活的向往"],
            ["D", "促进人的自由发展"],
        ])
        self.assertEqual(question["answer"], ["C"])
        self.assertEqual(question["type"], "single")

    def test_existing_b_option_prevents_false_embedded_b_split(self):
        question, _ = self.parse_one([
            "70. 下列说法正确的是（A）。",
            "A. 维生素B.群属于水溶性维生素",
            "B. 维生素C属于水溶性维生素",
            "C. 以上均正确",
        ])
        self.assertEqual(question["options"][0], ["A", "维生素B.群属于水溶性维生素"])
        self.assertEqual([key for key, _ in question["options"]], list("ABC"))

    def test_a_share_market_phrase_is_not_treated_as_an_option(self):
        question, _ = self.parse_one([
            "71. 下列关于A股市场的说法正确的是（A）。",
            "A. 正确",
            "B. 错误",
        ])
        self.assertEqual(question["prompt"], "下列关于A股市场的说法正确的是（ ）。")
        self.assertEqual(question["options"], [["A", "正确"], ["B", "错误"]])

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

    def test_utf8_text_file_uses_generic_import_pipeline(self):
        lines, metadata = server.extract_document_lines(
            "1. 示例题（A）\nA. 正确\nB. 错误".encode("utf-8"),
            "题库.txt",
        )
        self.assertEqual(metadata["method"], "plain-text")
        questions, warnings = server.parse_docx_questions(lines)
        self.assertEqual(len(questions), 1, warnings)
        self.assertEqual(questions[0]["answer"], ["A"])

    def test_html_file_keeps_block_boundaries(self):
        payload = b"<h1>1. Example (A)</h1><p>A. Yes</p><p>B. No</p>"
        lines, metadata = server.extract_document_lines(payload, "bank.html")
        self.assertEqual(metadata["method"], "html")
        self.assertEqual(lines, ["1. Example (A)", "A. Yes", "B. No"])

    def test_xlsx_rows_are_extracted_without_third_party_packages(self):
        payload = BytesIO()
        with ZipFile(payload, "w") as archive:
            archive.writestr(
                "xl/worksheets/sheet1.xml",
                """<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData>
                <row><c t=\"inlineStr\"><is><t>1. 表格题（A）</t></is></c></row>
                <row><c t=\"inlineStr\"><is><t>A. 正确</t></is></c></row>
                <row><c t=\"inlineStr\"><is><t>B. 错误</t></is></c></row>
                </sheetData></worksheet>""",
            )
        lines, metadata = server.extract_document_lines(payload.getvalue(), "bank.xlsx")
        self.assertEqual(metadata["method"], "spreadsheet")
        questions, warnings = server.parse_docx_questions(lines)
        self.assertEqual(len(questions), 1, warnings)
        self.assertEqual(questions[0]["options"], [["A", "正确"], ["B", "错误"]])

    def test_tutor_request_keeps_complete_question_and_paired_history(self):
        question, explanation, history, message = server.prepare_tutor_request({
            "question": {
                "sourceId": "q1",
                "prompt": "示例题",
                "options": [{"key": "A", "text": "正确"}, {"key": "B", "text": "错误"}],
                "answer": ["A"],
                "userAnswer": ["B"],
            },
            "explanation": "A 符合定义。",
            "history": [
                {"role": "user", "content": "为什么？"},
                {"role": "assistant", "content": "因为 A 符合定义。"},
            ],
            "message": "能举例吗？",
        })
        self.assertEqual(question["answer"], ["A"])
        self.assertEqual(explanation, "A 符合定义。")
        self.assertEqual([item["role"] for item in history], ["user", "assistant"])
        self.assertEqual(message, "能举例吗？")

    def test_tutor_request_rejects_unpaired_history(self):
        with self.assertRaisesRegex(ValueError, "缺少助教回答"):
            server.prepare_tutor_request({
                "question": {
                    "sourceId": "q1",
                    "prompt": "示例题",
                    "options": [{"key": "A", "text": "正确"}, {"key": "B", "text": "错误"}],
                    "answer": ["A"],
                    "userAnswer": ["B"],
                },
                "explanation": "解析",
                "history": [{"role": "user", "content": "为什么？"}],
                "message": "继续",
            })


if __name__ == "__main__":
    unittest.main()
