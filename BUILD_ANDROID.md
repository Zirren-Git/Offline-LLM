# Build the Android APK locally

This source pre-release can be built on your own Windows, macOS or Linux computer. **GitHub Actions, a paid GitHub plan, private repositories and Pro credentials are not required.** The shared `@offgrid/*` packages are included under `vendor/shared/packages/`.

**Status:** the JavaScript release bundle, production TypeScript and 66 focused tests passed in the preparation environment. The native Android build has **not** been completed or tested on a device: GitHub refused to start its runner because of an account billing restriction, and the preparation sandbox cannot reach Android dependency servers. Treat this as an experimental source pre-release, not a verified APK release.

## Windows: separate, self-contained batch downloads

Use the **standalone `install-build-dependencies.bat` and `build-apk.bat` downloads** from local-build.4 or newer. They include their own PowerShell implementation: no companion `.ps1` files are needed. You may keep these two files in Downloads, outside the source folder. The separate Windows build-tools ZIP also contains just the two launchers and usage instructions, not the app source.

The repository is private, so the scripts do **not** download source anonymously, request credentials, or embed a GitHub token. You still need to download/extract the app's **Source code (zip)** using your browser. Prefer a short local path such as `C:\src\Offline-LLM`.

1. Double-click the **new `install-build-dependencies.bat`**. Confirm its banner says **`2026.10.16.4`**.
   - If it cannot find the project beside the batch file or at a previously remembered location, paste the full extracted source folder path when asked. Choose the folder containing `package.json`, `android/` and `vendor/`, not the `android` subfolder or the ZIP file itself.
   - Uses Windows Package Manager (`winget`) to install Node.js 22 LTS and Temurin JDK 17 if suitable tools are missing. Existing Node.js 22.13+ is reused.
   - Installs official Android command-line tools if needed. Android Studio is optional for this route.
   - Prompts for SDK licenses, installs API 36, Build-Tools 36.0.0, NDK 27.1.12297006, CMake 3.22.1 and Platform-Tools, then runs `npm ci` with native patches.
2. When setup succeeds, double-click the **new `build-apk.bat`**. It remembers the source folder from setup, builds one ARM64 release APK and prints its path and SHA-256 hash.

Expected output under the selected source folder:

```text
android\app\build\outputs\apk\release\app-release.apk
```

### Errors and recovery

No script can recover from every possible Windows, network, hardware or dependency error. These launchers use bounded SDK download/extraction retries, verify SDK files, stage copies on the SDK's own drive and preserve incomplete installations before replacing them. They stop with a nonzero exit code rather than report success after a failed installation/build.

For the reported missing `unpacked\cmdline-tools\bin` error, **run the newly downloaded batch file**, not a shortcut to the old one. These standalone files never load the old PowerShell helpers from your source checkout. The version banner identifies the implementation being run. Do not manually create the missing TEMP directory.

On failure, read the named step and diagnostic log path. Logs and the remembered source path are stored in:

```text
%LOCALAPPDATA%\Offline-LLM\windows-build
```

Review/redact logs before sharing them: they include personal paths and build-tool output. If Windows blocks PowerShell or denies access to this directory, the bootstrap prints an error; permissions or organizational policy must be fixed manually. Antivirus quarantine, insufficient disk space, SDK license rejection and unavailable download servers cannot be solved by ignoring the error.

Incomplete existing `cmdline-tools/latest` files are preserved as `latest.incomplete-<unique-id>`. Complete tools are reused. An interrupted setup can be rerun; cleanup failures must not hide the actual error. Installation of Node/JDK can request administrator approval. The SDK location is taken from `android/local.properties`, then `ANDROID_HOME` / `ANDROID_SDK_ROOT`, falling back to `%LOCALAPPDATA%\Android\Sdk`.

These launchers target **x64 Windows 10/11** and Windows PowerShell 5.1+. Install/update Microsoft's App Installer if `winget` is missing, or install Node/JDK manually. Internet and at least 30 GB free disk space are recommended. Native builds can take a long time.

Both windows remain open at the end. From Command Prompt, add `--no-pause` to skip the final pause (SDK license prompts remain interactive). From PowerShell, prefix the filename with `.\`:

```bat
install-build-dependencies.bat --no-pause
build-apk.bat --no-pause
```

To explicitly select a different project, set `OFFLINE_LLM_SOURCE_DIR` to its full path before launching, or place the batch files beside that project's `package.json`.

**Signing warning:** the APK uses the included public debug key unless you configure your own keystore (see below). Do not treat it as a trusted production signing identity.

### Validation for maintainers

The launchers are generated from the PowerShell sources so embedded copies cannot silently diverge:

```text
python scripts/windows/package-standalone.py
python scripts/windows/package-standalone.py --check
python scripts/windows/tests/test_standalone.py
```

Filesystem regression fixtures can be run on Windows without downloading SDK tools:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\windows\tests\android-sdk-tools.test.ps1
```

Optionally add `-SdkDestinationRoot D:\Temp` (an existing writable directory on another drive) to test copying from TEMP to a different SDK volume. Packaging and syntax checks passed in the preparation environment; **Windows execution and the native Android build remain unverified**.

## 1. Install the prerequisites

- **Node.js 22 LTS**, including npm. Use Node 22.13 or later in that major version.
- **JDK 17**, for example Eclipse Temurin 17. Set `JAVA_HOME` to its installation directory (not its `bin` directory).
- **Android Studio**, including the Android SDK and SDK command-line tools.
- **Git** if cloning; it is optional if using the attached source ZIP.
- A reasonably powerful computer: 16 GB RAM and at least 30 GB free disk space are recommended. The native AI libraries are large, so allow substantial download and build time.

Internet is required for the initial npm, Gradle, Maven and SDK downloads. “Locally” here means building on your computer, **not** a guaranteed air-gapped/offline build. Do not use Gradle's `--offline` flag for the first build.

Check your terminal's tools:

```text
node --version
npm --version
java -version
```

Expect Node `v22.x` and Java `17.x`. If `JAVA_HOME` points to a different Java installation than the one shown by `java -version`, fix it before proceeding.

## 2. Get this exact source version

### Option A: download the pre-release ZIP

Download **Source code (zip)** from the GitHub pre-release page and extract it. Open a terminal in the extracted project folder (its name may include the release tag), the one containing `package.json`, `android/` and `vendor/`.

On Windows, extract into a short local path such as `C:\src\Offline-LLM` to reduce native build path-length problems. Avoid OneDrive/network folders.

### Option B: clone the release tag

```sh
git clone --branch v0.0.114-local-build.4 --depth 1 https://github.com/Zirren-Git/Offline-LLM.git
cd Offline-LLM
```

No submodule initialization or sibling `shared/` checkout is needed. Do not run the old private-source provisioning steps from other workflows.

## 3. Install the Android SDK components

In Android Studio, open **SDK Manager** (from the welcome screen: **More Actions → SDK Manager**; from a project: **Tools → SDK Manager**).

1. Under **SDK Platforms**, install **Android API 36**.
2. Under **SDK Tools**, enable **Show Package Details** and install:
   - Android SDK Build-Tools **36.0.0**
   - Android SDK Platform-Tools
   - Android SDK Command-line Tools (latest)
   - NDK (Side by side) **27.1.12297006**
   - CMake **3.22.1**
3. Note the **Android SDK Location** displayed in SDK Manager.

Use those pinned NDK/build-tools versions rather than substituting the newest versions. The project's Gradle wrapper downloads **Gradle 8.13** automatically; do not install a separate system Gradle.

### macOS / Linux environment

Set the path to the SDK directory you actually installed. Typical defaults:

```sh
# macOS:
export ANDROID_HOME="$HOME/Library/Android/sdk"
# Linux instead:
# export ANDROID_HOME="$HOME/Android/Sdk"

export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
# Set JAVA_HOME to your JDK 17 installation if it is not already set.
# On macOS with JDK 17 installed:
# export JAVA_HOME="$(/usr/libexec/java_home -v 17)"
```

These exports affect the current terminal. Put the appropriate values in your shell profile if you want them to persist.

### Windows PowerShell environment

Adjust these example paths to match your SDK and JDK installations:

```powershell
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:JAVA_HOME = "C:\Program Files\Eclipse Adoptium\jdk-17-YOUR-INSTALLED-VERSION"
$env:Path = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:ANDROID_HOME\cmdline-tools\latest\bin;$env:Path"
```

Replace the `JAVA_HOME` example with a real directory; `YOUR-INSTALLED-VERSION` is not a literal path. Alternatively set these variables through Windows Environment Variables and open a new terminal.

### Accept the licenses

After setting up the SDK path, run:

```text
sdkmanager --licenses
```

On Windows, use `sdkmanager.bat --licenses` if needed. Review and accept the required licenses. If SDK Manager did not install a component, you can install it from the terminal:

```text
sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0" "ndk;27.1.12297006" "cmake;3.22.1"
```

### Tell Gradle where the SDK is

In the source folder, create **`android/local.properties`** containing one line with your SDK's absolute path. This is a local, ignored file; do not distribute it.

macOS example:

```properties
sdk.dir=/Users/yourname/Library/Android/sdk
```

Linux example:

```properties
sdk.dir=/home/yourname/Android/Sdk
```

Windows example (forward slashes avoid Java properties escaping problems):

```properties
sdk.dir=C:/Users/yourname/AppData/Local/Android/Sdk
```

## 4. Install the app dependencies

From the source folder (the directory containing `package-lock.json`):

```sh
npm ci
```

Use `npm ci`, not an unlocked dependency upgrade. Let the normal installation scripts run: `patch-package` applies the repository's native dependency fixes.

If you downloaded a source ZIP, Husky may print that `.git` is missing. That warning alone does not prevent the build; a source archive does not include Git history. An actual npm error or failed patch must be fixed before continuing.

You do **not** need to separately build the vendored TypeScript packages; Metro resolves their source directly.

## 5. Build one standalone ARM64 APK

This is the recommended target for a modern physical Android phone. It produces **one APK**, not an Android App Bundle or a split-APK set.

### macOS / Linux

```sh
cd android
chmod +x gradlew
./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a --no-daemon --max-workers=2
```

### Windows PowerShell

```powershell
cd android
.\gradlew.bat assembleRelease -PreactNativeArchitectures=arm64-v8a --no-daemon --max-workers=2
```

Wait for **`BUILD SUCCESSFUL`**. The first run downloads Gradle and many native dependencies and compiles C/C++; it can take a long time. The app's release JavaScript bundle and Hermes bytecode are generated automatically. You do **not** need to start Metro, leave a development server running, or run `npm start`.

The finished file is:

```text
android/app/build/outputs/apk/release/app-release.apk
```

That path is relative to the source folder. If your terminal is still inside `android/`, use `app/build/outputs/apk/release/app-release.apk`.

### Other CPU architectures

ARM64 APKs cannot run on 32-bit-only phones or x86_64-only emulators. Check a connected device with:

```text
adb shell getprop ro.product.cpu.abilist
```

For a typical x86_64 Android emulator, substitute `-PreactNativeArchitectures=x86_64`. Omitting the architecture flag requests the project's four configured ABIs (`armeabi-v7a,arm64-v8a,x86,x86_64`) in one larger APK. Those additional native library/ABI combinations have not been validated in this pre-release; ARM64 is the intended starting point.

## 6. Install it on your phone

Option A: copy `app-release.apk` onto your phone, open it and allow that file manager/browser to **install unknown apps** when Android asks. Only install APKs from sources you trust.

Option B: enable Developer options and USB debugging, connect the phone, approve the computer on the phone, then run (from the source folder):

```text
adb devices
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

If your terminal is inside `android/`, shorten the APK path to `app/build/outputs/apk/release/app-release.apk`.

Model weights are not bundled in the source or APK. Download/import a supported model in the app before trying local inference. Running an already-downloaded local model does not require GitHub Actions.

## Signing: important before sharing or updating

By default, this project's **release build falls back to the included debug signing key** when no custom signing properties are supplied. This makes a locally installable APK, but it is **not a private production signing identity**. Anyone with the source has that key. Do not use it for a trusted public production release.

The release application ID is `ai.offgridmobile`. If another build with that ID is already installed using a different signing key, Android will reject the update (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`). Back up any chats/models you need before uninstalling anything; uninstalling can erase app data. A debug variant uses the separate ID `ai.offgridmobile.dev`, but is not the standalone release APK described above.

For your own stable signing identity:

1. Create a keystore **outside this repository** (replace the destination with your own absolute path):

   ```text
   keytool -genkeypair -v -keystore /absolute/private/path/offline-llm.jks -alias offline-llm -keyalg RSA -keysize 2048 -validity 10000
   ```

   On Windows use a path such as `C:/Users/yourname/private/offline-llm.jks`. `keytool` prompts for passwords; do not put them into chat or Git.

2. Add these properties to your **user-level** Gradle properties file (`~/.gradle/gradle.properties` on macOS/Linux, `%USERPROFILE%\.gradle\gradle.properties` on Windows). Create the directory/file if necessary. Do not put these secrets into the source archive or commit them:

   ```properties
   OFFGRID_UPLOAD_STORE_FILE=/absolute/private/path/offline-llm.jks
   OFFGRID_UPLOAD_STORE_PASSWORD=your-keystore-password
   OFFGRID_UPLOAD_KEY_ALIAS=offline-llm
   OFFGRID_UPLOAD_KEY_PASSWORD=your-key-password
   ```

   Use an absolute path and forward slashes on Windows. Restrict access to this file and use Java-properties-compatible escaping if your passwords contain special characters.

3. Re-run the release build command. Back up the keystore and passwords securely: future updates must use the same signing identity.

Optional signature verification (substitute your SDK's actual path):

```sh
"$ANDROID_HOME/build-tools/36.0.0/apksigner" verify --verbose --print-certs android/app/build/outputs/apk/release/app-release.apk
```

On Windows, use `apksigner.bat` from that build-tools directory.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| `SDK location not found` | The actual SDK directory, `ANDROID_HOME`, and `android/local.properties`. |
| Java/Gradle compatibility error | Run `java -version`; use JDK 17 and check `JAVA_HOME`. In Android Studio, also set the project's Gradle JDK to 17. |
| Missing NDK/CMake or SDK licenses | Install the exact versions from step 3, then run `sdkmanager --licenses`. |
| npm cannot find `@offgrid/*` | Confirm that `vendor/shared/packages/` was extracted, and run `npm ci` from the source folder. No private shared repo is needed. |
| `patch-package` fails | Use the release's original lockfile and unmodified dependency versions. Do not bypass patches with `--ignore-scripts`. |
| Maven/Gradle download failures | Check internet/proxy/firewall access to Google's Android repositories, Maven Central and Gradle's distribution servers. Retry after resolving connectivity. |
| Build runs out of memory | Close other heavy apps; try `--max-workers=1`. The default Gradle heap is 4 GB, so leave room for native compilers too. |
| Windows CMake/path errors | Extract to a short path such as `C:\src\Offline-LLM`; install the exact SDK tools above. |
| `INSTALL_FAILED_NO_MATCHING_ABIS` | Check the phone/emulator ABI; rebuild for it rather than installing an incompatible ARM64 APK. |
| Signature/update conflict | Read the signing section. Do not uninstall your existing app without backing up important data. |
| App crashes after installation | Capture `adb logcat -d > android-crash.log` immediately after reproducing it. Review/redact logs before sharing; they may contain private information. |

For a build failure, repeat the same command with `--stacktrace` added and retain the **first actual failing task/error**. This release has not passed a native Android build, so please report concrete build errors rather than assuming the source is fully verified.
