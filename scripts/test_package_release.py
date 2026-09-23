"""Offline checks for package integrity and the publishing permission boundary."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("package_release", ROOT / "scripts/package-release.py")
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.artifact = self.root / "python" / "openaxis-1.0.0rc1.whl"
        self.artifact.parent.mkdir()
        self.artifact.write_bytes(b"artifact")
        self.manifest = {
            "public_commit": "a" * 40, "source_commit": "b" * 40, "dirty": False,
            "packages": {"python": {"version": "1.0.0rc1", "checked": True,
                "files": {"python/openaxis-1.0.0rc1.whl": release.sha256(self.artifact)}}},
        }
        release.save(self.root, self.manifest)

    def test_modified_artifact_and_wrong_revision_are_rejected(self):
        release.load(self.root, "a" * 40, "b" * 40, ["python"])
        with self.assertRaisesRegex(RuntimeError, "different"):
            release.load(self.root, "c" * 40, "b" * 40, ["python"])
        self.artifact.write_bytes(b"changed")
        with self.assertRaisesRegex(RuntimeError, "changed"):
            release.load(self.root, "a" * 40, "b" * 40, ["python"])

    def test_artifact_path_cannot_escape_manifest_directory(self):
        self.manifest["packages"]["python"]["files"] = {"../outside.whl": "ignored"}
        release.save(self.root, self.manifest)
        with self.assertRaisesRegex(RuntimeError, "escaped"):
            release.load(self.root, "a" * 40, "b" * 40, ["python"])

    def test_failed_recheck_clears_previous_success(self):
        with patch.object(release, "run", side_effect=RuntimeError("install failed")):
            with self.assertRaises(RuntimeError):
                release.check(self.root, self.root, self.manifest, ["python"])
        self.assertFalse(json.loads((self.root / "manifest.json").read_text())["packages"]["python"]["checked"])

    def test_missing_legal_files_and_nuget_targets_are_rejected(self):
        artifact = self.root / "OpenAxis.nupkg"
        with zipfile.ZipFile(artifact, "w") as archive:
            archive.writestr("LICENSE", "license")
        with self.assertRaisesRegex(RuntimeError, "LEGAL"):
            release.inspect(artifact)
        with zipfile.ZipFile(artifact, "a") as archive:
            archive.writestr("LEGAL.md", "legal")
        with self.assertRaisesRegex(RuntimeError, "net48"):
            release.inspect(artifact)

    def workflow_verifier(self):
        # Exercise the exact no-checkout verification code used by the OIDC job.
        workflow = (ROOT / ".github/workflows/packages.yml").read_text()
        inline = workflow.split("python3 - <<'PY'\n", 1)[1].split("\n          PY", 1)[0]
        return "\n".join(line[10:] for line in inline.splitlines())

    def test_oidc_job_verifies_clean_commit_and_checked_archive(self):
        artifacts = self.root / "artifacts"
        (artifacts / "python").mkdir(parents=True)
        wheel = artifacts / "python/openaxis-1.0.0rc1.whl"
        source = artifacts / "python/openaxis-1.0.0rc1.tar.gz"
        wheel.write_bytes(b"wheel")
        source.write_bytes(b"source")
        self.manifest["packages"]["python"]["files"] = {
            p.relative_to(artifacts).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in (wheel, source)}
        output = self.root / "output"
        env = {"GITHUB_SHA": "a" * 40, "PACKAGE": "python", "VERSION": "1.0.0rc1", "GITHUB_OUTPUT": str(output)}
        import os
        previous = Path.cwd()
        try:
            os.chdir(self.root)
            with patch.dict(os.environ, env):
                release.save(artifacts, self.manifest)
                exec(self.workflow_verifier(), {})
                self.manifest["dirty"] = True
                release.save(artifacts, self.manifest)
                with self.assertRaisesRegex(AssertionError, "clean checkout"):
                    exec(self.workflow_verifier(), {})
                self.manifest["dirty"] = False
                release.save(artifacts, self.manifest)
                wheel.write_bytes(b"changed")
                with self.assertRaisesRegex(AssertionError, "Artifact changed"):
                    exec(self.workflow_verifier(), {})
        finally:
            os.chdir(previous)

    def test_workflow_has_no_stored_credentials_or_build_in_publish_job(self):
        workflow = (ROOT / ".github/workflows/packages.yml").read_text()
        build, publish = workflow.split("\n  publish:\n", 1)
        publish, tag = publish.split("\n  tag:\n", 1)
        self.assertNotIn("id-token: write", build)
        self.assertNotIn("contents: write", build + publish)
        self.assertIn("id-token: write", publish)
        self.assertIn("environment: publish-${{ inputs.package }}", publish)
        self.assertNotIn("actions/checkout@", publish)
        self.assertNotIn("secrets.", workflow)
        self.assertNotIn("pull_request", workflow)
        self.assertIn("--ignore-scripts", publish)
        self.assertIn("contents: write", tag)
        self.assertIn("default: false", build)
        self.assertIn("refs/heads/master", build)
        import re
        for action in re.findall(r"uses: (\S+)", workflow):
            self.assertRegex(action, r"@[0-9a-f]{40}$")


if __name__ == "__main__":
    unittest.main()
