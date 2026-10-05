#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
swift build --package-path native -c release --arch arm64 --arch x86_64
native_bin_dir=$(swift build --package-path native -c release --arch arm64 --arch x86_64 --show-bin-path)
mkdir -p 'dist/Cloud Agents Native.app/Contents/MacOS'
cp "$native_bin_dir/CloudAgents" 'dist/Cloud Agents Native.app/Contents/MacOS/CloudAgents'
cat > 'dist/Cloud Agents Native.app/Contents/Info.plist' <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>CloudAgents</string><key>CFBundleIdentifier</key><string>dev.cloudagents.native</string><key>CFBundleName</key><string>Cloud Agents Native</string><key>CFBundleVersion</key><string>1</string><key>CFBundleShortVersionString</key><string>0.1.0</string><key>LSMinimumSystemVersion</key><string>14.0</string><key>NSHighResolutionCapable</key><true/><key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict></dict></plist>
PLIST
codesign --force --deep --sign - 'dist/Cloud Agents Native.app'
(cd dist && ditto -c -k --sequesterRsrc --keepParent 'Cloud Agents Native.app' Cloud-Agents-Native-macOS.zip)
printf 'Built dist/Cloud Agents Native.app (ad-hoc signed, not notarized).\n'
