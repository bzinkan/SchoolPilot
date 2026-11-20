"""Compile and run portable gateway tests. Requires g++ or clang++ on PATH."""
import argparse
import pathlib
import os
import shutil
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument("--compiler", default=shutil.which("g++") or shutil.which("clang++"))
args = parser.parse_args()
if not args.compiler:
    parser.error("Install a C++ compiler, or pass --compiler <absolute-path>")
root = pathlib.Path(__file__).resolve().parents[1]
env = dict(os.environ)
env["PATH"] = str(pathlib.Path(args.compiler).resolve().parent) + os.pathsep + env["PATH"]
with tempfile.TemporaryDirectory(prefix="passpilot-gateway-tests-") as temp:
    binary = pathlib.Path(temp) / "gateway-tests.exe"
    subprocess.run([args.compiler, "-std=c++17", "-Wall", "-Wextra", "-Werror", "-I", str(root / "include"),
                    str(root / "test/native.cpp"), "-o", str(binary)], check=True, env=env)
    subprocess.run([str(binary)], check=True, env=env)
