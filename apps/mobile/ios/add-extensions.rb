# One-off: adds the share extension and the widget extension targets to App.xcodeproj and embeds
# them in the app. Run from apps/mobile/ios: `ruby add-extensions.rb` (needs `gem install xcodeproj`).
# Safe to run again: targets that already exist are left alone. The widget needs iOS 16 (lock-screen
# widgets); on iOS 15 the app installs and simply doesn't offer it.
require 'xcodeproj'

project = Xcodeproj::Project.open('App/App.xcodeproj')
app = project.targets.find { |t| t.name == 'App' }
version = app.build_configurations.first.build_settings['MARKETING_VERSION']
build = app.build_configurations.first.build_settings['CURRENT_PROJECT_VERSION']

app.build_configurations.each { |c| c.build_settings['CODE_SIGN_ENTITLEMENTS'] = 'App/App.entitlements' }
unless project.main_group['App'].files.any? { |f| f.path == 'App.entitlements' }
  project.main_group['App'].new_reference('App.entitlements')
end

embed = app.copy_files_build_phases.find { |p| p.name == 'Embed Foundation Extensions' } ||
        app.new_copy_files_build_phase('Embed Foundation Extensions').tap { |p| p.symbol_dst_subfolder_spec = :plug_ins }

def add_extension(project, app, embed, name:, bundle:, sources:, plist:, entitlements: nil, frameworks: [], version:, build:, ios: '15.0')
  return if project.targets.any? { |t| t.name == name }
  target = project.new_target(:app_extension, name, :ios, ios)
  group = project.main_group.new_group(name, name)
  sources.each { |s| target.add_file_references([group.new_reference(s)]) }
  group.new_reference(plist)
  group.new_reference(entitlements) if entitlements
  frameworks.each { |f| target.add_system_framework(f) }
  target.build_configurations.each do |c|
    s = c.build_settings
    s['PRODUCT_BUNDLE_IDENTIFIER'] = bundle
    s['PRODUCT_NAME'] = '$(TARGET_NAME)'
    s['INFOPLIST_FILE'] = "#{name}/#{plist}"
    s['GENERATE_INFOPLIST_FILE'] = 'NO'
    s['CODE_SIGN_ENTITLEMENTS'] = "#{name}/#{entitlements}" if entitlements
    s['CODE_SIGN_STYLE'] = 'Automatic'
    s['MARKETING_VERSION'] = version
    s['CURRENT_PROJECT_VERSION'] = build
    s['SWIFT_VERSION'] = '5.0'
    s['TARGETED_DEVICE_FAMILY'] = '1,2'
    s['IPHONEOS_DEPLOYMENT_TARGET'] = ios
    s['SKIP_INSTALL'] = 'YES'
    s['LD_RUNPATH_SEARCH_PATHS'] = ['$(inherited)', '@executable_path/Frameworks', '@executable_path/../../Frameworks']
    s['APPLICATION_EXTENSION_API_ONLY'] = 'YES'
  end
  app.add_dependency(target)
  embed.add_file_reference(target.product_reference).settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }
end

add_extension(project, app, embed, name: 'ShareExtension', bundle: 'com.omniclip.app.share',
              sources: %w[ShareViewController.swift HubClient.swift OmniClipCrypto.swift], plist: 'Info.plist',
              entitlements: 'ShareExtension.entitlements', version: version, build: build)
add_extension(project, app, embed, name: 'OmniClipWidget', bundle: 'com.omniclip.app.widget',
              sources: %w[OmniClipWidget.swift], plist: 'Info.plist', frameworks: %w[WidgetKit SwiftUI], version: version, build: build, ios: '16.0')

project.save
puts 'done'
