# Real-ESRGAN x4v3 Core ML model (~2.4 MB download, ~5 MB compiled),
# materialised by `bun run sr:model` (scripts/fetch-sr-model.ts). Without it
# the pod still builds and the feature reports unavailable; Release builds
# refuse to build without it (NEMU_SR_MODEL_OPTIONAL=1 overrides).
sr_dir = File.join(__dir__, 'Models', 'NemuSuperResolution')
sr_files = %w[RealESRGAN-x4v3.mlmodelc manifest.json SR-NOTICES.txt]
sr_bundled = sr_files.all? { |name| File.exist?(File.join(sr_dir, name)) }

Pod::Spec.new do |s|
  s.name           = 'NemuSuperResolution'
  s.version        = '1.0.0'
  s.summary        = 'On-device cover super-resolution (Real-ESRGAN x4v3, Core ML)'
  s.description    = 'Upscales manga covers 4x on the Neural Engine with the compact Real-ESRGAN x4v3 model, tiled with overlap blending. Runs entirely on-device.'
  s.author         = 'Nemu'
  s.homepage       = 'https://nemu.pm'
  s.platforms      = { :ios => '17.0' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'CoreML', 'ImageIO', 'CryptoKit'

  xcconfig = {
    'DEFINES_MODULE' => 'YES',
    # The model check below reads the pod's own Models/ folder.
    'ENABLE_USER_SCRIPT_SANDBOXING' => 'NO',
    'NEMU_SR_MODEL_BUNDLED' => sr_bundled ? 'YES' : 'NO',
  }
  s.source_files = '*.swift'
  if sr_bundled
    s.resource_bundles = {
      'NemuSuperResolution' => sr_files.map { |name| "Models/NemuSuperResolution/#{name}" }
    }
  end
  s.script_phase = {
    :name => 'Check super-resolution model',
    :execution_position => :before_compile,
    :always_out_of_date => '1',
    :script => <<~'SH',
      if [ "${CONFIGURATION}" != "Release" ]; then exit 0; fi
      if [ "${NEMU_SR_MODEL_OPTIONAL:-0}" = "1" ]; then exit 0; fi
      dir="${PODS_TARGET_SRCROOT}/Models/NemuSuperResolution"
      for name in RealESRGAN-x4v3.mlmodelc manifest.json SR-NOTICES.txt; do
        if [ ! -e "${dir}/${name}" ]; then
          echo "error: super-resolution model file missing: ${dir}/${name}"
          echo "error: run 'bun run sr:model' in apps/mobile (scripts/fetch-sr-model.ts), then 'pod install' in apps/mobile/ios."
          echo "error: set NEMU_SR_MODEL_OPTIONAL=1 to build a Release without it (covers stay at source resolution)."
          exit 1
        fi
      done
      if [ "${NEMU_SR_MODEL_BUNDLED}" != "YES" ]; then
        echo "error: the super-resolution model exists but was not present at 'pod install'; run 'pod install' in apps/mobile/ios so it is bundled."
        exit 1
      fi
    SH
  }
  s.pod_target_xcconfig = xcconfig
end
