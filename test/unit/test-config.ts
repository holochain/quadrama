const sinon = require('sinon')
const test = require('tape')
const TOML = require('@iarna/toml')

import * as T from '../../src/types'
import * as C from '../../src/config';
import * as Gen from '../../src/config/gen';
import { genConfigArgs } from '../common';

const blah = {} as any

type CC = T.ConductorConfig

export const { configPlain, configSugared } = (() => {
  const dna = C.dna('path/to/dna.json', 'dna-id', { uuid: 'uuid' })
  const common = {
    bridges: [C.bridge('b', 'alice', 'bob')],
    dpki: C.dpki('alice', { well: 'hello' }),
  }
  const instancesSugared = {
    alice: dna,
    bob: dna,
  }
  const instancesDesugared: Array<T.InstanceConfig> = [
    {
      id: 'alice',
      agent: {
        id: 'alice',
        name: 'name::alice::uuid',
        keystore_file: '[UNUSED]',
        public_address: '[SHOULD BE REWRITTEN]',
        test_agent: true,
      },
      dna: {
        id: 'dna-id',
        file: 'path/to/dna.json',
        uuid: 'uuid'
      }
    },
    {
      id: 'bob',
      agent: {
        id: 'bob',
        name: 'name::bob::uuid',
        keystore_file: '[UNUSED]',
        public_address: '[SHOULD BE REWRITTEN]',
        test_agent: true,
      },
      dna: {
        id: 'dna-id',
        file: 'path/to/dna.json',
        uuid: 'uuid'
      }
    }
  ]
  const configSugared = Object.assign({}, common, { instances: instancesSugared })
  const configPlain = Object.assign({}, common, { instances: instancesDesugared })
  return { configPlain, configSugared }
})()

const configEmpty: T.ConductorConfig = {
  instances: []
}

test('DNA id generation', t => {
  t.equal(C.dnaPathToId('path/to/file'), 'file')
  t.equal(C.dnaPathToId('path/to/file.dna'), 'file.dna')
  t.equal(C.dnaPathToId('path/to/file.json'), 'file.json')
  t.equal(C.dnaPathToId('path/to/file.dna.json'), 'file')

  t.equal(C.dnaPathToId('file'), 'file')
  t.equal(C.dnaPathToId('file.json'), 'file.json')
  t.equal(C.dnaPathToId('file.dna.json'), 'file')
  t.end()
})

test('Sugared config', async t => {
  t.deepEqual(C.desugarConfig({ conductorName: 'name', uuid: 'uuid' } as T.GenConfigArgs, configSugared), configPlain)
  t.end()
})

test('genInstanceConfig', async t => {
  const stubGetDnaHash = sinon.stub(Gen, 'getDnaHash').resolves('fakehash')
  const { agents, dnas, instances, interfaces } = await C.genInstanceConfig(configPlain, await genConfigArgs())
  t.equal(agents.length, 2)
  t.equal(dnas.length, 1)
  t.equal(instances.length, 2)
  t.equal(interfaces.length, 2)
  t.ok(interfaces[0].admin, true)
  t.equal(interfaces[0].instances.length, 0)
  t.notOk(interfaces[1].admin)
  t.equal(interfaces[1].instances.length, 2)
  t.end()
  stubGetDnaHash.restore()
})

test('genBridgeConfig', async t => {
  const { bridges } = await C.genBridgeConfig(configPlain)
  t.deepEqual(bridges, [{ handle: 'b', caller_id: 'alice', callee_id: 'bob' }])
  t.end()
})

test('genBridgeConfig, empty', async t => {
  const json = await C.genBridgeConfig(configEmpty)
  t.notOk('bridges' in json)
  t.end()
})

test('genDpkiConfig', async t => {
  const { dpki } = await C.genDpkiConfig(configPlain)
  t.deepEqual(dpki, { instance_id: 'alice', init_params: '{"well":"hello"}' })
  t.end()
})

test('genDpkiConfig, empty', async t => {
  const json = await C.genDpkiConfig(configEmpty)
  t.notOk('dpki' in json)
  t.end()
})

test('genSignalConfig', async t => {
  const { signals } = await C.genSignalConfig(configPlain)
  t.ok('trace' in signals)
  t.ok('consistency' in signals)
  t.equal(signals.consistency, true)
  t.end()
})

test('genNetworkConfig', async t => {
  const c1 = await C.genNetworkConfig({network: 'memory'} as CC, {configDir: ''}, blah)
  const c2 = await C.genNetworkConfig({network: 'websocket'} as CC, {configDir: ''}, blah)
  t.equal(c1.network.type, 'memory')
  t.equal(c1.network.transport_configs[0].type, 'memory')
  t.equal(c2.network.type, 'websocket')
  t.equal(c2.network.transport_configs[0].type, 'websocket')
  t.end()
})

test('genLoggerConfig', async t => {
  const loggerVerbose = await C.genLoggerConfig({logger: true} as CC, {configDir: ''}, blah)
  const loggerQuiet = await C.genLoggerConfig({logger: false} as CC, {configDir: ''}, blah)

  const expectedVerbose = TOML.parse(`
[logger]
type = "debug"
state_dump = false
[[logger.rules.rules]]
exclude = false
pattern = ".*"
  `)

  const expectedQuiet = TOML.parse(`
[logger]
type = "debug"
state_dump = false
[[logger.rules.rules]]
exclude = true
pattern = ".*"
  `)

  t.deepEqual(loggerVerbose, expectedVerbose)
  t.deepEqual(loggerQuiet, expectedQuiet)
  t.end()
})

test('genConfig produces valid TOML', async t => {
  const stubGetDnaHash = sinon.stub(Gen, 'getDnaHash').resolves('fakehash')
  const builder = C.genConfig(configSugared, {logger: false, network: 'n3h'})
  const toml = await builder({ configDir: 'dir', adminPort: 1111, zomePort: 2222, uuid: 'uuid', conductorName: 'conductorName' })
  const json = TOML.parse(toml)
  const toml2 = TOML.stringify(json)
  t.equal(toml, toml2 + "\n")
  t.end()
  stubGetDnaHash.restore()
})

test('invalid config throws nice error', async t => {
  t.throws(() => {
    C.genConfig({
      instances: [
        {id: 'what'}
      ]
    } as any, {logger: false, network: 'n3h'})({ 
      configDir: 'dir', adminPort: 1111, zomePort: 2222, uuid: 'uuid', conductorName: 'conductorName' 
    }),
    /Tried to use an invalid value/
  })
  t.end()
})