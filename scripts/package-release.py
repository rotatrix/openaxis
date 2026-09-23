"""Build and test local package artifacts. This script never publishes or reads secrets."""
import argparse
import ast
from email.parser import BytesParser
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import uuid
import zipfile
import xml.etree.ElementTree as ET

PACKAGES = ("python", "typescript", "csharp", "cpp")
PREFIXES = {"python": "py", "typescript": "ts", "csharp": "cs", "cpp": "cpp"}
NAMES = {"python": "openaxis (PyPI)", "typescript": "@openaxis/sdk (npm)",
         "csharp": "OpenAxis (NuGet)", "cpp": "OpenAxis C++ source"}


def source_version(repo, package):
    if package == "python":
        tree = ast.parse((repo / "py/openaxis/src/openaxis/_version.py").read_text())
        values = [ast.literal_eval(n.value) for n in tree.body if isinstance(n, ast.Assign)
                  and any(isinstance(t, ast.Name) and t.id == "__version__" for t in n.targets)]
        if len(values) != 1:
            raise RuntimeError("Expected one Python version")
        version = values[0]
    elif package == "typescript":
        version = json.loads((repo / "ts/sdk/package.json").read_text())["version"]
    elif package == "csharp":
        version = ET.parse(repo / "cs/OpenAxis/OpenAxis.csproj").findtext(".//Version")
    else:
        header = (repo / "cpp/include/openaxis/version.hpp").read_text()
        version = re.search(r'sdk_version\s*=\s*"([^"\n]+)"', header)[1]
        cmake = (repo / "cpp/CMakeLists.txt").read_text()
        base = re.search(r"project\(OpenAxis VERSION ([0-9.]+)", cmake)[1]
        if version.split("-", 1)[0] != base:
            raise RuntimeError("C++ header and CMake versions differ")
    if not isinstance(version, str) or not re.fullmatch(r"[0-9][0-9A-Za-z.+-]*", version):
        raise RuntimeError("Invalid package version")
    return version


def parse_release_tag(tag):
    match = re.fullmatch(r"(py|ts|cs|cpp)/v([0-9][0-9A-Za-z.+-]*)", tag)
    if not match:
        raise RuntimeError("Expected py/v..., ts/v..., cs/v..., or cpp/v... release tag")
    return next(k for k, v in PREFIXES.items() if v == match[1]), match[2]


def validate_release_tag(repo, tag):
    package, version = parse_release_tag(tag)
    if source_version(repo, package) != version:
        raise RuntimeError("Release tag does not match the checked-in package version")
    commit = git(repo, "rev-parse", "HEAD")
    if git(repo, "rev-parse", f"refs/tags/{tag}^{{commit}}") != commit:
        raise RuntimeError("Release tag does not point to the checked-out commit")
    git(repo, "merge-base", "--is-ancestor", commit, "refs/remotes/origin/master")
    return package, version


def artifact_version(path):
    if path.suffix == ".whl":
        with zipfile.ZipFile(path) as archive:
            names = [n for n in archive.namelist() if n.endswith(".dist-info/METADATA")]
            if len(names) != 1:
                raise RuntimeError("Expected one wheel metadata file")
            return BytesParser().parsebytes(archive.read(names[0]))["Version"]
    if path.suffix == ".nupkg":
        with zipfile.ZipFile(path) as archive:
            names = [n for n in archive.namelist() if n.endswith(".nuspec")]
            if len(names) != 1:
                raise RuntimeError("Expected one NuGet manifest")
            return ET.fromstring(archive.read(names[0])).findtext(".//{*}version")
    with tarfile.open(path) as archive:
        if path.suffix == ".tgz":
            return json.load(archive.extractfile("package/package.json"))["version"]
        if path.name.startswith("openaxis-cpp-"):
            header = archive.extractfile("cpp/include/openaxis/version.hpp").read().decode()
            return re.search(r'sdk_version\s*=\s*"([^"\n]+)"', header)[1]
        names = [n for n in archive.getnames() if n.endswith("/PKG-INFO") and n.count("/") == 1]
        if len(names) != 1:
            raise RuntimeError("Expected one source distribution metadata file")
        return BytesParser().parsebytes(archive.extractfile(names[0]).read())["Version"]

def run(args, cwd, *, quiet=False):
    args = [str(arg) for arg in args]
    executable = shutil.which(args[0])
    if not executable:
        raise RuntimeError(f"Missing executable: {args[0]}")
    result = subprocess.run([executable, *args[1:]], cwd=cwd,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, encoding="utf-8", errors="replace")
    output = result.stdout
    if not quiet or result.returncode:
        print(output, end="", flush=True)
    if result.returncode:
        raise RuntimeError(f"{args[0]} failed (exit {result.returncode}); see output above.")
    return output.strip()


def git(repo, *args):
    return run(["git", *args], repo, quiet=True)


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(root, manifest):
    temporary = root / "manifest.new"
    temporary.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    temporary.replace(root / "manifest.json")


def inspect(path):
    if path.suffix in (".whl", ".nupkg"):
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
    else:
        with tarfile.open(path) as archive:
            names = archive.getnames()
    for required in ("LICENSE", "LEGAL.md"):
        if not any(Path(name).name == required for name in names):
            raise RuntimeError(f"{path.name} is missing {required}")
    if any(part in ("private", ".git", "node_modules") for name in names for part in Path(name).parts):
        raise RuntimeError(f"Unexpected private/dependency files in {path.name}")
    if path.suffix == ".nupkg":
        for target in ("net48", "netstandard2.0"):
            if f"lib/{target}/OpenAxis.dll" not in names:
                raise RuntimeError(f"Missing NuGet target {target}")
    print(f"Inspected {path.name}: {len(names)} entries")


def prepare(repo, root, selected, public, source):
    if root.exists():
        raise RuntimeError("Artifact directory already exists. Use check, or choose a fresh --artifacts directory.")
    root.mkdir(parents=True)
    manifest = {"public_commit": public, "source_commit": source, "packages": {}}
    if "typescript" in selected:
        run(["pnpm", "install", "--frozen-lockfile"], repo)
    for package in selected:
        output = root / package
        output.mkdir()
        if package == "python":
            run(["uv", "build", "--no-sources", repo / "py/openaxis", "--out-dir", output], repo)
            files = sorted([*output.glob("*.whl"), *output.glob("*.tar.gz")])
            if len(files) != 2:
                raise RuntimeError("Expected one wheel and one source distribution.")
            version = files[0].name.split("-")[1]
            run(["uvx", "twine", "check", *files], repo)
        elif package == "typescript":
            run(["pnpm", "-C", "ts/sdk", "build"], repo)
            run(["pnpm", "-C", "ts/sdk", "pack", "--pack-destination", output], repo)
            files = list(output.glob("*.tgz"))
            version = json.loads((repo / "ts/sdk/package.json").read_text())["version"]
        elif package == "cpp":
            version = source_version(repo, package)
            artifact = output / f"openaxis-cpp-{version}.tar.gz"
            tracked = git(repo, "ls-files", "-z", "--", "cpp", "fixtures", "LICENSE", "LEGAL.md")
            with tarfile.open(artifact, "w:gz") as archive:
                for name in tracked.split("\0"):
                    if name:
                        archive.add(repo / name, arcname=name, recursive=False)
            files = [artifact]
        else:
            run(["dotnet", "pack", "cs/OpenAxis/OpenAxis.csproj", "-c", "Release", "-o", output], repo)
            files = list(output.glob("*.nupkg"))
            version = files[0].name.removeprefix("OpenAxis.").removesuffix(".nupkg") if files else ""
        if package != "python" and len(files) != 1:
            raise RuntimeError(f"Expected one {package} package.")
        for path in files:
            inspect(path)
            if artifact_version(path) != source_version(repo, package):
                raise RuntimeError(f"Built package version differs from source: {path.name}")
        manifest["packages"][package] = {
            "version": version, "files": {p.relative_to(root).as_posix(): sha256(p) for p in files},
            "checked": False,
        }
    if git(repo, "rev-parse", "HEAD") != public:
        raise RuntimeError("Source changed while preparing packages.")
    save(root, manifest)
    print(f"Prepared packages: {root}")


def load(root, public, source, selected):
    root = root.resolve()
    manifest = json.loads((root / "manifest.json").read_text())
    if (manifest["public_commit"], manifest["source_commit"]) != (public, source):
        raise RuntimeError("Artifacts belong to a different public/private revision.")
    for package in selected:
        if package not in manifest["packages"]:
            raise RuntimeError(f"{package} was not prepared.")
        for relative, digest in manifest["packages"][package]["files"].items():
            path = (root / relative).resolve()
            if not path.is_relative_to(root) or sha256(path) != digest:
                raise RuntimeError(f"Artifact changed or escaped its directory: {relative}")
    return manifest


def check(repo, root, manifest, selected):
    consumer = root / "consumers" / uuid.uuid4().hex[:8]
    consumer.mkdir(parents=True)
    for package in selected:
        item = manifest["packages"][package]
        item["checked"] = False
        save(root, manifest)
        files = [(root / name).resolve() for name in item["files"]]
        work = consumer / package
        work.mkdir()
        if package == "python":
            for index, artifact in enumerate(files):
                venv = work / f"venv-{index}"
                run(["uv", "venv", venv, "--python", "3.11", "--no-project"], work)
                python = venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
                run(["uv", "pip", "install", "--python", python, artifact], work)
                run([python, "-I", "-c", "import importlib,importlib.metadata,pkgutil,pathlib,sys,openaxis; "
                     "assert pathlib.Path(openaxis.__file__).is_relative_to(pathlib.Path(sys.prefix)); "
                     f"assert importlib.metadata.version('openaxis') == {item['version']!r}; "
                     "modules=list(pkgutil.walk_packages(openaxis.__path__,'openaxis.')); "
                     "[importlib.import_module(m.name) for m in modules]; "
                     "print('Imported',len(modules),'modules from',openaxis.__file__)"], work)
        elif package == "typescript":
            manager = json.loads((repo / "package.json").read_text())["packageManager"]
            (work / "package.json").write_text(json.dumps({"private": True, "type": "module", "packageManager": manager}))
            # A nested directory would otherwise join the repository's pnpm workspace.
            (work / "pnpm-workspace.yaml").write_text("packages: []\n")
            run(["pnpm", "add", str(files[0])], work)
            compiler = json.loads((repo / "package.json").read_text())["devDependencies"]["typescript"]
            run(["pnpm", "add", "-D", f"typescript@{compiler}"], work)
            (work / "probe.ts").write_text('''import * as sdk from '@openaxis/sdk';
import * as protocol from '@openaxis/sdk/protocol';
import * as geometry from '@openaxis/sdk/geometry';
import * as diagnostics from '@openaxis/sdk/diagnostics';
const client: sdk.OpenAxisClient | undefined = undefined;
for (const mod of [sdk, protocol, geometry, diagnostics]) {
  if (!Object.keys(mod).length) throw new Error('Empty public entry point');
}
if (new geometry.Vec3(1, 2, 3).dot(new geometry.Vec3(1, 0, 0)) !== 1) throw new Error('Geometry');
console.log('Four public entry points and TypeScript declarations passed', client);
''')
            run(["pnpm", "exec", "tsc", "probe.ts", "--module", "NodeNext", "--moduleResolution", "NodeNext",
                 "--target", "ES2022", "--strict"], work)
            run(["node", "probe.js"], work)
        elif package == "cpp":
            with tarfile.open(files[0]) as archive:
                archive.extractall(work, filter="data")
            # The SDK's test executables use assert; keep assertions enabled.
            run(["cmake", "-S", work / "cpp", "-B", work / "out", "-DCMAKE_BUILD_TYPE=Debug",
                 "-DOPENAXIS_BUILD_TESTS=ON", "-DOPENAXIS_BUILD_DEMO=OFF", "-DOPENAXIS_WARNINGS_AS_ERRORS=ON"], work)
            run(["cmake", "--build", work / "out", "--config", "Debug", "--parallel", "2"], work)
            run(["ctest", "--test-dir", work / "out", "-C", "Debug", "--output-on-failure"], work)
        else:
            from xml.sax.saxutils import escape
            targets = "net8.0;net48" if os.name == "nt" else "net8.0"
            (work / "Probe.csproj").write_text(f'''<Project Sdk="Microsoft.NET.Sdk">
<PropertyGroup><OutputType>Exe</OutputType><TargetFrameworks>{targets}</TargetFrameworks></PropertyGroup>
<ItemGroup><PackageReference Include="OpenAxis" Version="[{escape(item['version'])}]" /></ItemGroup></Project>''')
            (work / "NuGet.Config").write_text(f'''<configuration><packageSources><clear/>
<add key="local" value="{escape(str(files[0].parent), {'"': '&quot;'})}"/>
<add key="nuget.org" value="https://api.nuget.org/v3/index.json"/></packageSources>
<packageSourceMapping><packageSource key="local"><package pattern="OpenAxis"/></packageSource>
<packageSource key="nuget.org"><package pattern="*"/></packageSource></packageSourceMapping></configuration>''')
            (work / "Program.cs").write_text('''using System;
using OpenAxis.Client;
using OpenAxis.Navigation;
class Program { static void Main() {
var assembly = typeof(OpenAxisClient).Assembly;
Console.WriteLine(assembly.Location);
Console.WriteLine(typeof(NavigationSession).FullName);
Console.WriteLine("Public types loaded: " + assembly.GetExportedTypes().Length);
if (Protocol.Version != "openaxis/1.0") throw new Exception("Protocol mismatch");
} }
''')
            run(["dotnet", "restore", "--packages", work / "packages"], work)
            run(["dotnet", "build", "-c", "Release", "--no-restore"], work)
            run(["dotnet", "run", "-c", "Release", "--no-build", "-f", "net8.0"], work)
            if os.name == "nt":
                run([work / "bin/Release/net48/Probe.exe"], work)
        item["checked"] = True
        save(root, manifest)
    print(f"Local package checks passed; consumers retained in {consumer}")


def release_summary(manifest, package):
    item = manifest["packages"][package]
    lines = [f"## {NAMES[package]} {item['version']}", "",
             f"Release tag: `{PREFIXES[package]}/v{item['version']}`",
             f"Public commit: `{manifest['public_commit']}`",
             f"Private source commit: `{manifest.get('source_commit') or 'not recorded'}`",
             f"Installation checks: {'passed' if item['checked'] else 'not passed'}"]
    if package == "typescript":
        lines.append(f"npm dist-tag: `{'next' if '-' in item['version'] else 'latest'}`")
    lines.extend(["", "| Artifact | SHA-256 |", "| --- | --- |"])
    lines.extend(f"| `{name}` | `{digest}` |" for name, digest in item["files"].items())
    lines.extend(["", "Any approved publication uses these exact checked artifacts.", ""])
    return "\n".join(lines)



def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("prepare", "check", "metadata", "validate-tag"))
    parser.add_argument("--package", choices=PACKAGES, required=True)
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument("--artifacts", type=Path)
    args = parser.parse_args()
    repo = args.repo.resolve()
    release_tag = os.environ.get("GITHUB_REF_NAME") if os.environ.get("GITHUB_REF_TYPE") == "tag" else None
    if args.command == "validate-tag":
        package, version = validate_release_tag(repo, release_tag or "")
        if package != args.package:
            raise RuntimeError("Release tag selects a different package")
        print(f"Validated {release_tag}: {package} {version}")
        return 0
    public = git(repo, "rev-parse", "HEAD")
    trailer = re.search(r"^Source-Commit: ([0-9a-f]{40})$", git(repo, "log", "-100", "--format=%B"), re.M)
    source = trailer[1] if trailer else None
    root = (args.artifacts or repo / "build/packages" / public / args.package).resolve()
    if not root.is_relative_to((repo / "build").resolve()):
        raise RuntimeError("Artifacts must stay under the checkout's build/ directory.")
    selected = [args.package]
    if args.command == "prepare":
        prepare(repo, root, selected, public, source)
        manifest = load(root, public, source, selected)
        manifest["dirty"] = bool(git(repo, "status", "--porcelain", "--untracked-files=all"))
        save(root, manifest)
    else:
        manifest = load(root, public, source, selected)
        if args.command == "check":
            check(repo, root, manifest, selected)
        else:
            item = manifest["packages"][args.package]
            version = item["version"]
            if not re.fullmatch(r"[0-9][0-9A-Za-z.+-]*", version):
                raise RuntimeError("Invalid package version")
            if not item["checked"]:
                raise RuntimeError("Package checks must pass first")
            tag = f"{PREFIXES[args.package]}/v{version}"
            if release_tag and release_tag != tag:
                raise RuntimeError("Built package version does not match release tag")
            outputs = {"version": version, "tag": tag, "package-name": NAMES[args.package]}
            if os.environ.get("GITHUB_STEP_SUMMARY"):
                with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as stream:
                    stream.write(release_summary(manifest, args.package))
            if os.environ.get("GITHUB_OUTPUT"):
                with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as stream:
                    for key, value in outputs.items():
                        stream.write(f"{key}={value}\n")
            print(json.dumps(outputs))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, OSError, ValueError, KeyError) as error:
        print(f"Error: {error}", file=sys.stderr)
        sys.exit(1)
