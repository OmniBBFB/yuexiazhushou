const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// Exercise the actual transport selector with each fixture's wx implementation.
function cloudBackend(build, wx) {
  const context = {
    exports: {}, wx,
    require: name => name.includes('config/backend') ? { backendConfig: { mode: 'cloud' } }
      : name.includes('virtual-users') ? { virtualUser: () => '' }
        : require(path.join(build, 'miniprogram/services/telemetry.js')),
  }
  vm.runInNewContext(fs.readFileSync(path.join(build, 'miniprogram/services/backend.js'), 'utf8'), context)
  return context.exports
}
module.exports = { cloudBackend }
