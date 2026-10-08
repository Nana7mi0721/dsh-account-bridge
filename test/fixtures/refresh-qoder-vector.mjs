/**
 * 生成/刷新 qoder COSY 的定标向量（`test/fixtures/qoder-cosy-vector.json`）。
 *
 *     node test/fixtures/refresh-qoder-vector.mjs
 *
 * ## 为什么要一个脚本，而不是"两边各算一遍再对比"
 *
 * COSY 里的 `Cosy-Key` 是 **RSA-PKCS1v1.5 加密**的，而 PKCS#1 v1.5 加密
 * **自带随机填充**：同一个公钥加密同一段明文，两次结果必然不同
 * （确定的只有"用私钥能解回原文"）。所以「固定输入 → 固定输出」这条要求
 * **不能用在密文上**，任何逐字节对比密文/签名的测试都在测一个不存在的性质。
 *
 * 于是定标拆成三条互相独立的路：
 *
 * 1. **AES 段**（`infoB64`）：固定 key + 固定 iv → 密文确定，直接钉死。
 * 2. **RSA 段**（`cosyKey`）：用**本脚本自己的一对丢弃测试密钥**加密一次。
 *    「密文能解回 `aesKey`」这条性质由 `test/qoder.test.js` 在运行时现生成
 *    密钥对来验——**私钥不落盘、不进版本库**（`.gitignore` 有 `*.pem`）。
 *    向量里只留公钥，公钥本来就不是秘密。
 * 3. **签名段**：`sigInput = payloadB64 \n cosyKey \n timestamp \n body \n sigPath`
 *    的 md5 是确定的（cosyKey 只是它的**输入**），所以直接把 cosyKey 当输入
 *    复算一次即可，与实现里的公式独立。
 *
 * 上游真正的公钥是 `src/wire/qoder.js` 的 `COSY_PUBLIC_KEY`（公开信息，
 * 与逆向源码逐字节一致），测试里另有一条断言确认它没被改坏。
 *
 * 这个脚本**不是**单测的一部分：跑一次把向量写进仓库，之后测试只读它。
 * 换算法时才需要重跑。
 */

import { createPublicKey, generateKeyPairSync, publicEncrypt } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { COSY_PUBLIC_KEY, buildCosyHeaders } from '../../src/wire/qoder.js'

const here = dirname(fileURLToPath(import.meta.url))

const AES_KEY = '0123456789abcdef'
const REQUEST_ID = '11111111-2222-4333-8444-555555555555'
const TIMESTAMP = '1700000000'
const MACHINE_ID = 'fixture-machine-id'
const BODY = '{"hello":"world"}'
const SIG_PATH = '/api/v2/model/list'
const REQUEST_URL = 'https://api3.qoder.sh/algo/api/v2/model/list?Encode=1'
const USER_INFO = {
  uid: 'u_fixture',
  security_oauth_token: 'job-token-fixture',
  name: 'Fixture User',
  aid: '',
  email: 'fixture@example.com',
}

// 结构与 Node 的 JSON.stringify 一致：无空格、键按插入顺序。
const userInfoJson = JSON.stringify(USER_INFO)

// 一把丢弃的测试密钥，**只在内存里活着**：私钥不落盘、不进版本库。
const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 1024 })
const testPublicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()

const cosyKey = publicEncrypt(
  { key: testPublicPem, padding: 1 /* RSA_PKCS1_PADDING */ },
  Buffer.from(AES_KEY),
).toString('base64')

// 用被测实现算一遍整套头（随机量、时间戳、以及那个随机的 RSA 密文全部注入）。
// 注入 cosyKey 之后整条签名才真正确定，Python 那一侧才能复算出同一串字节。
const headers = buildCosyHeaders({
  body: BODY,
  url: REQUEST_URL,
  credentials: {
    userID: USER_INFO.uid,
    authToken: USER_INFO.security_oauth_token,
    name: USER_INFO.name,
    email: USER_INFO.email,
    machineID: MACHINE_ID,
  },
  publicKey: testPublicPem,
  random: { aesKey: AES_KEY, cosyKey, requestId: REQUEST_ID, timestamp: TIMESTAMP, xRequestId: REQUEST_ID },
})

const payloadB64 = headers.Authorization.slice('Bearer COSY.'.length).split('.')[0]
const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'))

// 签名输入与签名都从**实现算出来的头**里读回去（不在这里重新推导公式，
// 否则就变成"实现和自己比"）。公式本身由 Python 那一侧独立复核。
const sigInput = [payloadB64, cosyKey, TIMESTAMP, BODY, SIG_PATH].join('\n')
const expectedSig = headers.Authorization.slice(`Bearer COSY.${payloadB64}.`.length)

const vector = {
  _comment: [
    '由 test/fixtures/refresh-qoder-vector.mjs 生成。',
    'COSY 签名为逆向所得（上游无官方文档）。',
    '注意：cosyKey 是 RSA-PKCS1v1.5 密文，带随机填充、不可复现——',
    '定标方式是"用私钥解密回 aesKey"（由 test/qoder.test.js 运行时现生成密钥对来验），',
    '不是逐字节比对。这里用的是本文件自带的丢弃测试密钥对，与上游公钥无关。',
  ].join(''),
  aesKey: AES_KEY,
  timestamp: TIMESTAMP,
  machineId: MACHINE_ID,
  requestId: REQUEST_ID,
  requestIdHeader: REQUEST_ID,
  requestUrl: REQUEST_URL,
  sigPath: SIG_PATH,
  body: BODY,
  bodyHash: headers['Cosy-Bodyhash'],
  bodyLength: headers['Cosy-Bodylength'],
  authorization: headers.Authorization,
  cosyKey,
  payloadB64,
  infoB64: payload.info,
  userInfoJson,
  sigInput,
  expectedSig,
  testPublicKeyPem: testPublicPem,
}

writeFileSync(join(here, 'qoder-cosy-vector.json'), `${JSON.stringify(vector, null, 2)}\n`, 'utf8')

// 自检：真正的上游公钥必须仍然是逆向源码里那一把（1024-bit，SPKI 逐字节一致）。
const upstreamDer = createPublicKey(COSY_PUBLIC_KEY).export({ type: 'spki', format: 'der' }).toString('base64')
const expectedDer = createPublicKey(`-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----
`).export({ type: 'spki', format: 'der' }).toString('base64')
if (upstreamDer !== expectedDer) throw new Error('COSY_PUBLIC_KEY drifted from the reverse-engineered key')

console.log('wrote test/fixtures/qoder-cosy-vector.json')
console.log('wrote test/fixtures/qoder-cosy-test-key.pem')
console.log(`authorization = ${vector.authorization}`)
console.log(`infoB64       = ${vector.infoB64}`)
