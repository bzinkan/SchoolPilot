"""Select only this project's local config.h, never an SDK's unrelated config.h."""
from pathlib import Path
Import("env")
if (Path(env["PROJECT_DIR"]) / "include/config.h").is_file():
    env.Append(CPPDEFINES=["PP_HAS_LOCAL_CONFIG"])
