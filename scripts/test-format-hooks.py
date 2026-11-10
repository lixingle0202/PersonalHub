"""Exercise real commit hooks in isolated repositories, including partial staging."""

from __future__ import annotations

import ast
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
CONFIG_FILES = (
    ".pre-commit-config.yaml",
    ".prettierrc.json",
    ".prettierignore",
    ".editorconfig",
    "pyproject.toml",
)


class FormatHookTests(unittest.TestCase):
    def setUp(self):
        sandbox_root = ROOT / ".test-runtime" / "format-hook-tests"
        sandbox_root.mkdir(parents=True, exist_ok=True)
        self.repo = Path(tempfile.mkdtemp(prefix="repo 空格-", dir=sandbox_root))
        self.assertTrue(self.repo.resolve().is_relative_to(sandbox_root.resolve()))
        self.env = os.environ.copy()
        self.env.pop("GIT_INDEX_FILE", None)
        self.env.pop("GIT_DIR", None)
        self.env.pop("GIT_WORK_TREE", None)
        self.env["PYTHONIOENCODING"] = "utf-8"
        self.env["PYTHONUTF8"] = "1"
        for name in CONFIG_FILES:
            shutil.copy2(ROOT / name, self.repo / name)
        self.git("init", "-q")
        self.git("config", "user.name", "PersonalHub hook test")
        self.git("config", "user.email", "hooks@example.invalid")
        self.git("config", "core.autocrlf", "false")
        self.git("add", "--", *CONFIG_FILES)
        self.git("commit", "-q", "-m", "test: seed isolated hook repository")
        self.run_command(
            sys.executable, "-X", "utf8", "-m", "pre_commit", "install", "--install-hooks"
        )

    def run_command(self, *args, check=True):
        result = subprocess.run(
            args,
            cwd=self.repo,
            env=self.env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=180,
            encoding="utf-8",
            errors="replace",
        )
        if check:
            self.assertEqual(result.returncode, 0, result.stdout)
        return result

    def git(self, *args, check=True):
        return self.run_command("git", *args, check=check)

    def write(self, name, content):
        path = self.repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8", newline="")
        return path

    def test_commit_formats_code_and_keeps_unstaged_files_and_images(self):
        python_source = "def  greet( name ):return {'message':name}   \n"
        python_path = self.write("backend/app/format sample.py", python_source)
        js_path = self.write(
            "frontend/src/format sample.js", 'const greeting={name:"learner"};   \n'
        )
        private_path = self.write("local note.txt", "  keep this unstaged  \n\n")
        private_before = private_path.read_bytes()
        image = self.repo / "example.png"
        image.write_bytes(b"\x89PNG\r\n\x1a\n\x00\x80\xffbinary fixture\x00")
        image_before = image.read_bytes()
        self.git(
            "add",
            "--",
            "backend/app/format sample.py",
            "frontend/src/format sample.js",
            "example.png",
        )
        head_before = self.git("rev-parse", "HEAD").stdout.strip()

        first = self.git("commit", "-m", "test: exercise automatic formatting", check=False)
        self.assertNotEqual(first.returncode, 0, first.stdout)
        self.assertIn("files were modified", first.stdout)
        self.assertEqual(self.git("rev-parse", "HEAD").stdout.strip(), head_before)
        formatted_python = python_path.read_text(encoding="utf-8")
        self.assertIn("def greet(name):", formatted_python)
        self.assertIn('"message"', formatted_python)
        self.assertEqual(ast.dump(ast.parse(python_source)), ast.dump(ast.parse(formatted_python)))
        self.assertEqual(
            js_path.read_text(encoding="utf-8"), "const greeting = { name: 'learner' }\n"
        )
        self.assertEqual(private_path.read_bytes(), private_before)
        self.assertEqual(image.read_bytes(), image_before)

        self.git("add", "--", "backend/app/format sample.py", "frontend/src/format sample.js")
        second = self.git("commit", "-m", "test: exercise automatic formatting")
        self.assertIn("Passed", second.stdout)
        committed = self.git("ls-tree", "-r", "--name-only", "HEAD").stdout
        self.assertNotIn("local note.txt", committed)
        self.assertEqual(
            self.git("show", "HEAD:frontend/src/format sample.js").stdout,
            js_path.read_text(encoding="utf-8"),
        )

    def test_partial_staging_never_adds_private_working_changes(self):
        name = "backend/app/partial.py"
        path = self.write(name, "value = 1\n")
        self.git("add", "--", name)
        self.git("commit", "-m", "test: seed partial staging fixture")
        path.write_text("value=2\n", encoding="utf-8")
        self.git("add", "--", name)
        private_line = "private_note = 'do not stage me'\n"
        path.write_text("value=2\n" + private_line, encoding="utf-8")
        head_before = self.git("rev-parse", "HEAD").stdout.strip()

        attempt = self.git("commit", "-m", "test: preserve partial staging", check=False)
        self.assertNotEqual(attempt.returncode, 0, attempt.stdout)
        self.assertEqual(self.git("rev-parse", "HEAD").stdout.strip(), head_before)
        self.assertIn(private_line, path.read_text(encoding="utf-8"))
        staged = self.git("show", ":" + name).stdout
        self.assertNotIn("private_note", staged)
        self.assertIn("value", staged)

    def test_invalid_json_blocks_commit(self):
        self.write("frontend/invalid.json", '{"broken": }\n')
        self.git("add", "--", "frontend/invalid.json")
        head_before = self.git("rev-parse", "HEAD").stdout.strip()
        result = self.git("commit", "-m", "test: reject invalid configuration", check=False)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("Failed", result.stdout)
        self.assertEqual(self.git("rev-parse", "HEAD").stdout.strip(), head_before)

    def test_generated_files_are_excluded(self):
        catalog = self.write("backend/app/services/food_catalog_data.py", "DATA={'keep':1}   \n\n")
        lock = self.write("frontend/pnpm-lock.yaml", "generated: [leave this fixture alone\n")
        before = (catalog.read_bytes(), lock.read_bytes())
        self.git(
            "add", "--", "backend/app/services/food_catalog_data.py", "frontend/pnpm-lock.yaml"
        )
        self.git("commit", "-m", "test: preserve generated assets")
        self.assertEqual((catalog.read_bytes(), lock.read_bytes()), before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
