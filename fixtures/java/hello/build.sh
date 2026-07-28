#!/usr/bin/env bash
# Builds the java-hello fixture as a fat jar (aws-lambda-java-core shaded
# in, as real Lambda deployment jars are). target/java-hello.jar is
# committed so tests never need this script.
set -euo pipefail
cd "$(dirname "$0")"
CORE_VERSION=1.2.3
[ -f lambda-core.jar ] || curl -fsSL -o lambda-core.jar \
  "https://repo1.maven.org/maven2/com/amazonaws/aws-lambda-java-core/${CORE_VERSION}/aws-lambda-java-core-${CORE_VERSION}.jar"
rm -rf build target && mkdir -p build/classes target
javac --release 11 -cp lambda-core.jar -d build/classes src/example/Hello.java
(cd build/classes && jar xf ../../lambda-core.jar com)
jar cf target/java-hello.jar -C build/classes .
rm -rf build
echo "Built fixtures/java/hello/target/java-hello.jar"
