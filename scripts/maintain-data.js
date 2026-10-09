// Read-only by default. Run with administrator credentials in environment variables.
const cloudbase = require('../cloudfunctions/api/node_modules/@cloudbase/node-sdk')
const { inspect, migrate, cleanup } = require('../cloudfunctions/api/maintenance')
const mode = process.argv[2] || 'inspect'
const env = process.env.TT_CLOUD_ENV
if (!env) throw new Error('请设置 TT_CLOUD_ENV；默认只读检查，不读取小程序配置中的环境')
if (!['inspect', 'migrate', 'cleanup'].includes(mode)) throw new Error('仅支持 inspect、migrate、cleanup')
if (mode !== 'inspect' && !process.argv.includes('--apply')) throw new Error('写操作需要显式 --apply；请先备份并检查 inspect 报告')
const app = cloudbase.init({ env, secretId: process.env.TENCENTCLOUD_SECRETID, secretKey: process.env.TENCENTCLOUD_SECRETKEY })
const operation = { inspect, migrate, cleanup }[mode]
operation(app.database()).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1 })
