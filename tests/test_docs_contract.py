from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class DocumentationContractTests(unittest.TestCase):
    def read(self, relative: str) -> str:
        path = ROOT / relative
        self.assertTrue(path.exists(), f"missing contract document: {relative}")
        return path.read_text(encoding="utf-8")

    def test_ui_has_only_the_five_retained_primary_routes(self):
        text = self.read("docs/UI_SPEC.md")
        for route in [
            "| 首页总览 | `/` |", "| 今日计划 | `/today` |",
            "| 学习计划 | `/learning` |", "| 饮食计划 | `/diet` |",
            "| 数据与设置 | `/settings` |",
        ]:
            self.assertIn(route, text)
        for removed_route in ["| 自媒体 |", "| 开发工作 |", "| 咨询工作 |", "| 游戏娱乐 |"]:
            self.assertNotIn(removed_route, text)
        self.assertIn("`/games`", text)
        self.assertIn("返回首页", text)

    def test_data_model_has_all_domains(self):
        text = self.read("docs/DATA_MODEL.md")
        for table in [
            "agenda_items", "quick_notes", "media_contents", "dev_projects",
            "consultations", "learning_goals", "dishes", "games",
        ]:
            self.assertIn(table, text)
        self.assertIn("历史游戏表（仅兼容保留）", text)
        self.assertIn("软删除", text)

    def test_api_has_all_groups(self):
        text = self.read("docs/API.md")
        for marker in [
            "/api/v1/home", "/api/v1/agenda", "/api/v1/media",
            "/api/v1/dev/projects", "/api/v1/consultations",
            "/api/v1/learning/goals", "/api/v1/diet/dishes",
            "/api/v1/backups", "/api/v1/trash",
        ]:
            self.assertIn(marker, text)
        self.assertNotIn("/api/v1/games", text)

    def test_test_matrix_covers_all_prd_acceptance_sections(self):
        text = self.read("docs/TEST_CASES.md")
        for section in range(1, 9):
            self.assertIn(f"PRD-10.{section}", text)


if __name__ == "__main__":
    unittest.main()
