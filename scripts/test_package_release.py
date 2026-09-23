"""Offline checks for package integrity and the publishing permission boundary."""
import hashlib
import importlib.util
import io
import json
import subprocess
import tarfile
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

    def test_artifact_root_is_resolved_before_containment_check(self):
        # Windows runner TEMP may use an alias/junction; an unresolved parent
        # also exercises the mismatch without requiring symlink privileges.
        alias = self.root / "python" / ".."
        self.assertEqual(release.load(alias, "a" * 40, "b" * 40, ["python"]), self.manifest)
        self.manifest["packages"]["python"]["files"] = {"../outside.whl": "ignored"}
        release.save(self.root, self.manifest)
        with self.assertRaisesRegex(RuntimeError, "escaped"):
            release.load(alias, "a" * 40, "b" * 40, ["python"])

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

    def test_summary_identifies_version_commit_artifacts_and_npm_channel(self):
        summary = release.release_summary(self.manifest, "python")
        for value in ("openaxis (PyPI) 1.0.0rc1", "a" * 40, "b" * 40,
                      self.artifact.name, release.sha256(self.artifact), "checks: passed"):
            self.assertIn(value, summary)
        self.manifest["packages"]["typescript"] = {
            "version": "1.0.0-rc.1", "checked": True, "files": {"typescript/sdk.tgz": "abc"}}
        self.assertIn("npm dist-tag: `next`", release.release_summary(self.manifest, "typescript"))
        self.manifest["packages"]["typescript"]["version"] = "1.0.0"
        self.assertIn("npm dist-tag: `latest`", release.release_summary(self.manifest, "typescript"))

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
        env = {"GITHUB_SHA": "a" * 40, "GITHUB_REF": "refs/tags/py/v1.0.0rc1", "PACKAGE": "python", "VERSION": "1.0.0rc1", "GITHUB_OUTPUT": str(output)}
        import os
        previous = Path.cwd()
        try:
            os.chdir(self.root)
            with patch.dict(os.environ, env):
                release.save(artifacts, self.manifest)
                exec(self.workflow_verifier(), {})
                with patch.dict(os.environ, {"GITHUB_REF": "refs/tags/py/v9.9.9"}):
                    with self.assertRaisesRegex(AssertionError, "Wrong release tag"):
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
        publish, tag = publish.split("\n  release:\n", 1)
        self.assertNotIn("id-token: write", build)
        self.assertNotIn("contents: write", build + publish)
        self.assertIn("id-token: write", publish)
        self.assertIn("environment: publish-${{ needs.select.outputs.package }}", publish)
        self.assertNotIn("actions/checkout@", publish)
        self.assertNotIn("secrets.", workflow)
        self.assertIn("  pull_request:\n    branches: [master]", workflow)
        self.assertIn("  push:\n    branches: [master]", workflow)
        self.assertIn("github.event_name == 'push' && startsWith(github.ref, 'refs/tags/')", publish)
        self.assertIn("needs.select.outputs.release == 'true'", publish)
        self.assertNotIn("inputs.publish", workflow)
        self.assertIn("tags: ['py/v*', 'ts/v*', 'cs/v*', 'cpp/v*']", build)
        self.assertIn("validate-tag --package", build)
        self.assertIn("name: Publish ${{ needs.build.outputs.package-name }} ${{ needs.build.outputs.version }}", publish)
        self.assertIn("--ignore-scripts", publish)
        self.assertIn("contents: write", tag)
        self.assertNotIn("git.createRef", tag)
        self.assertIn("repos.createRelease", tag)
        self.assertIn("refs/heads/master:refs/remotes/origin/master", build)
        import re
        for action in re.findall(r"uses: (\S+)", workflow):
            self.assertRegex(action, r"@[0-9a-f]{40}$")

    def test_release_tag_selects_package_and_requires_exact_source_version(self):
        for package, prefix in release.PREFIXES.items():
            version = release.source_version(ROOT, package)
            tag = f"{prefix}/v{version}"
            self.assertEqual(release.parse_release_tag(tag), (package, version))
            with patch.object(release, "git", side_effect=["a" * 40, "a" * 40, ""]) as git:
                self.assertEqual(release.validate_release_tag(ROOT, tag), (package, version))
                git.assert_called_with(ROOT, "merge-base", "--is-ancestor", "a" * 40, "refs/remotes/origin/master")
            with self.assertRaisesRegex(RuntimeError, "version"):
                release.validate_release_tag(ROOT, f"{prefix}/v99.99.99")
        for tag in ("master", "python/v1.0.0", "py/v1.0.0/extra", "ts/v$(echo)"):
            with self.assertRaises(RuntimeError):
                release.parse_release_tag(tag)

    def test_release_tag_rejects_wrong_commit_and_off_master(self):
        tag = f"py/v{release.source_version(ROOT, 'python')}"
        with patch.object(release, "git", side_effect=["a" * 40, "b" * 40]):
            with self.assertRaisesRegex(RuntimeError, "checked-out commit"):
                release.validate_release_tag(ROOT, tag)
        with patch.object(release, "git", side_effect=["a" * 40, "a" * 40, RuntimeError("not ancestor")]):
            with self.assertRaisesRegex(RuntimeError, "not ancestor"):
                release.validate_release_tag(ROOT, tag)

    def test_archive_version_comes_from_metadata_not_filename(self):
        with zipfile.ZipFile(self.artifact, "w") as archive:
            archive.writestr("openaxis-1.0.0rc1.dist-info/METADATA", "Name: openaxis\nVersion: 9.9.9\n")
        self.assertEqual(release.artifact_version(self.artifact), "9.9.9")
        nupkg = self.root / "OpenAxis.1.0.0.nupkg"
        with zipfile.ZipFile(nupkg, "w") as archive:
            archive.writestr("OpenAxis.nuspec", '<package xmlns="urn:nuget"><metadata><version>2.0.0-rc.1</version></metadata></package>')
        self.assertEqual(release.artifact_version(nupkg), "2.0.0-rc.1")
        for filename, member, content, expected in (
            ("sdk.tgz", "package/package.json", b'{"version":"3.0.0"}', "3.0.0"),
            ("openaxis.tar.gz", "openaxis/PKG-INFO", b"Version: 4.0.0rc1\n", "4.0.0rc1"),
            ("openaxis-cpp-1.0.0.tar.gz", "cpp/include/openaxis/version.hpp", b'sdk_version = "5.0.0-rc.1";', "5.0.0-rc.1"),
        ):
            path = self.root / filename
            with tarfile.open(path, "w:gz") as archive:
                entry = tarfile.TarInfo(member)
                entry.size = len(content)
                archive.addfile(entry, io.BytesIO(content))
            self.assertEqual(release.artifact_version(path), expected)

    def test_actual_workflow_selector_only_releases_tag_pushes(self):
        workflow = (ROOT / ".github/workflows/packages.yml").read_text()
        script = workflow.split("          script: |\n", 1)[1].split("\n  build:", 1)[0]
        script = "\n".join(line[12:] for line in script.splitlines())
        cases = [
            ("push", "refs/heads/master", {}, "", False, list(release.PACKAGES)),
            ("pull_request", "refs/pull/1/merge", {}, "", False, list(release.PACKAGES)),
            ("workflow_dispatch", "refs/tags/ts/v1.0.0", {}, "typescript", False, ["typescript"]),
            ("push", "refs/tags/ts/v1.0.0", {"deleted": True}, "", False, list(release.PACKAGES)),
        ]
        cases.extend(("push", f"refs/tags/{prefix}/v1.0.0", {}, "", True, [package])
                     for package, prefix in release.PREFIXES.items())
        for event, ref, payload, requested, releases, packages in cases:
            context = {"eventName": event, "ref": ref, "payload": payload}
            harness = (f"const context = {json.dumps(context)}; const outputs = {{}}; "
                       "const core = {setOutput: (k,v) => outputs[k]=v}; "
                       f"process.env.REQUESTED_PACKAGE = {json.dumps(requested)};\n" + script
                       + "\nconsole.log(JSON.stringify(outputs));")
            result = subprocess.run(["node", "-e", harness], check=True, capture_output=True, text=True)
            outputs = json.loads(result.stdout)
            self.assertEqual(outputs["release"], str(releases).lower())
            self.assertEqual(json.loads(outputs["packages"]), packages)


if __name__ == "__main__":
    unittest.main()
