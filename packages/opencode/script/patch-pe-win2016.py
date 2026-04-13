#!/usr/bin/env python3
"""
Patch opencode.exe for Windows Server 2016 compatibility.

Bun runtime imports GetThreadDescription/SetThreadDescription from
KERNEL32.dll, but these functions are missing on early Server 2016
builds (before cumulative updates like KB4103720).

This script uses LIEF to move those imports from KERNEL32.dll to a
shim DLL (opencode_compat.dll) that we provide alongside the binary.
The shim DLL dynamically resolves them from KernelBase.dll (where they
DO exist on Server 2016) or returns harmless stubs.
"""

import lief
import sys
import os


def patch_binary(input_path: str, output_path: str, shim_dll: str = "opencode_compat.dll"):
    binary = lief.parse(input_path)
    if binary is None:
        print(f"ERROR: Failed to parse {input_path}")
        return False

    # Functions to move from KERNEL32.dll to shim DLL
    funcs_to_move = {"GetThreadDescription", "SetThreadDescription"}

    # Find which functions actually exist in KERNEL32 imports
    found_funcs = []
    kernel32_import = None
    for imp in binary.imports:
        if imp.name.upper() == "KERNEL32.DLL":
            kernel32_import = imp
            for entry in imp.entries:
                if entry.name in funcs_to_move:
                    found_funcs.append(entry.name)
            break

    if not found_funcs:
        print("No problematic imports found — binary may already be compatible.")
        return False

    print(f"Found imports to patch: {', '.join(found_funcs)}")

    # Add a new import for our shim DLL with the problematic functions
    shim_lib = binary.add_import(shim_dll)
    for func_name in found_funcs:
        shim_lib.add_entry(func_name)

    # Remove the functions from KERNEL32.dll imports
    if kernel32_import:
        for func_name in found_funcs:
            kernel32_import.remove_entry(func_name)

    # Write patched binary
    config = lief.PE.Builder.config_t()
    config.imports = True
    builder = lief.PE.Builder(binary, config)
    builder.build()
    builder.write(output_path)

    print(f"Patched binary written to: {output_path}")
    print(f"Moved {len(found_funcs)} imports to {shim_dll}")
    return True


def main():
    if len(sys.argv) < 2:
        print("Usage: patch-pe-win2016.py <input.exe> [output.exe]")
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2] if len(sys.argv) > 2 else input_path

    if not os.path.exists(input_path):
        print(f"File not found: {input_path}")
        sys.exit(1)

    success = patch_binary(input_path, output_path)
    if not success:
        sys.exit(1)

    print("Done! Place opencode_compat.dll next to the patched binary.")


if __name__ == "__main__":
    main()
