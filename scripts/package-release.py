"""Build and test local package artifacts. This script never publishes or reads secrets."""
import argparse
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

PACKAGES = ("python", "typescript", "csharp")

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
        else:
            run(["dotnet", "pack", "cs/OpenAxis/OpenAxis.csproj", "-c", "Release", "-o", output], repo)
            files = list(output.glob("*.nupkg"))
            version = files[0].name.removeprefix("OpenAxis.").removesuffix(".nupkg") if files else ""
        if package != "python" and len(files) != 1:
            raise RuntimeError(f"Expected one {package} package.")
        for path in files:
            inspect(path)
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



def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="replace")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("prepare", "check", "metadata"))
    parser.add_argument("--package", choices=PACKAGES, required=True)
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument("--artifacts", type=Path)
    args = parser.parse_args()
    repo = args.repo.resolve()
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
            outputs = {"version": version, "tag": f"{args.package}/v{version}"}
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
