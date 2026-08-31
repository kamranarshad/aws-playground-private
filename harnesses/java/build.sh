#!/usr/bin/env bash
# Builds harness.jar with Gson shaded in. Requires JDK 11+ and network
# (first run only, to download Gson from Maven Central). Run automatically
# by scripts/prepare.js -- the jar ships in the npm tarball but is not
# committed, so a source checkout builds it here.
set -euo pipefail
cd "$(dirname "$0")"
GSON_VERSION=2.11.0
[ -f gson.jar ] || curl -fsSL -o gson.jar \
  "https://repo1.maven.org/maven2/com/google/code/gson/gson/${GSON_VERSION}/gson-${GSON_VERSION}.jar"
rm -rf build && mkdir -p build/classes
javac --release 11 -cp gson.jar -d build/classes Harness.java
(cd build/classes && jar xf ../../gson.jar com)
jar cf harness.jar -C build/classes .
rm -rf build
echo "Built harnesses/java/harness.jar"
