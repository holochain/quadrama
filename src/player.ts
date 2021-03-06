const _ = require('lodash')

import { Signal, DnaId } from '@holochain/hachiko'

import { notImplemented } from './common'
import { Conductor } from './conductor'
import { GenConfigArgs, SpawnConductorFn, ObjectS } from './types';
import { getConfigPath } from './config';
import { makeLogger } from './logger';

type ConstructorArgs = {
  name: string,
  genConfigArgs: GenConfigArgs,
  onSignal: ({ instanceId: string, signal: Signal }) => void,
  onJoin: () => void,
  onLeave: () => void,
  spawnConductor: SpawnConductorFn,
}

type InstanceInfo = {
  agentAddress: string,
  dnaAddress: string,
}

/**
 * Representation of a Conductor user.
 * A Player is essentially a wrapper around a conductor config that was generated,
 * and the possible reference to a conductor which is running based on that config.
 * The Player can spawn or kill a conductor based on the generated config.
 * Players are the main interface for writing scenarios.
 */
export class Player {

  name: string
  logger: any
  onJoin: () => void
  onLeave: () => void
  onSignal: ({ instanceId: string, signal: Signal }) => void

  _conductor: Conductor | null
  _dnaIds: Array<DnaId>
  _genConfigArgs: GenConfigArgs
  _instanceInfo: ObjectS<InstanceInfo>
  _spawnConductor: SpawnConductorFn

  constructor({ name, genConfigArgs, onJoin, onLeave, onSignal, spawnConductor }: ConstructorArgs) {
    this.name = name
    this.logger = makeLogger(`player ${name}`)
    this.onJoin = onJoin
    this.onLeave = onLeave
    this.onSignal = onSignal
    this._conductor = null
    this._genConfigArgs = genConfigArgs
    this._instanceInfo = {}
    this._spawnConductor = spawnConductor
  }

  admin = (method, params) => {
    this._conductorGuard(`admin(${method}, ${JSON.stringify(params)})`)
    return this._conductor!.callAdmin(method, params)
  }

  call = (instanceId, zome, fn, params) => {
    this._conductorGuard(`call(${instanceId}, ${zome}, ${fn}, ${JSON.stringify(params)})`)
    return this._conductor!.callZome(instanceId, zome, fn, params)
  }

  info = (instanceId) => {
    this._conductorGuard(`info(${instanceId})`)
    return _.clone(this._instanceInfo[instanceId])
  }

  /**
   * spawn can take a function as an argument, which allows the caller
   * to do something with the child process handle, even before the conductor
   * has fully started up
   */
  spawn = async (f?: Function) => {
    if (this._conductor) {
      this.logger.warn(`Attempted to spawn conductor '${this.name}' twice!`)
      return
    }

    await this.onJoin()
    this.logger.debug("spawning")
    const path = getConfigPath(this._genConfigArgs.configDir)
    const handle = await this._spawnConductor(this.name, path)

    if (f) {
      this.logger.info('running spawned handle hack. TODO: document this :)')
      f(handle)
    }

    await this._awaitConductorInterfaceStartup(handle, this.name)

    this.logger.debug("spawned")
    this._conductor = new Conductor({
      name: this.name,
      handle,
      onSignal: this.onSignal.bind(this),
      ...this._genConfigArgs
    })

    this.logger.debug("initializing")
    await this._conductor.initialize()
    await this._setInstanceInfo()
    this.logger.debug("initialized")
  }

  kill = async (): Promise<void> => {
    if (this._conductor) {
      const c = this._conductor
      this._conductor = null
      this.logger.debug("Killing...")
      await c.kill('SIGINT')
      this.logger.debug("Killed.")
      await this.onLeave()
    } else {
      this.logger.warn(`Attempted to kill conductor '${this.name}' twice`)
    }
  }

  _setInstanceInfo = async () => {
    const agentList = await this._conductor!.callAdmin("admin/agent/list", {})
    const dnaList = await this._conductor!.callAdmin("admin/dna/list", {})
    const instanceList = await this._conductor!.callAdmin("admin/instance/list", {})
    instanceList.forEach(i => {
      const agent = agentList.find(a => a.id === i.agent)
      const dna = dnaList.find(d => d.id === i.dna)
      if (!agent) {
        throw new Error(`Instance '${i.id}' refers to nonexistant agent id '${i.agent}'`)
      }
      if (!dna) {
        throw new Error(`Instance '${i.id}' refers to nonexistant dna id '${i.dna}'`)
      }
      this._instanceInfo[i.id] = {
        agentAddress: agent.public_address,
        dnaAddress: dna.hash,
      }
    })
  }

  _conductorGuard = (context) => {
    if (this._conductor === null) {
      const msg = `Attempted conductor action when no conductor is running! You must \`.spawn()\` first.\nAction: ${context}`
      this.logger.error(msg)
      throw new Error(msg)
    } else {
      this.logger.debug(context)
    }
  }

  _awaitConductorInterfaceStartup = (handle, name) => {
    return new Promise((resolve, reject) => {
      handle.on('close', code => {
        this.logger.info(`conductor '${name}' exited with code ${code}`)
        reject(`Conductor exited before fully starting (code ${code})`)
      })
      handle.stdout.on('data', data => {
        // wait for the logs to convey that the interfaces have started
        // because the consumer of this function needs those interfaces
        // to be started so that it can initiate, and form,
        // the websocket connections
        if (data.toString('utf8').indexOf('Starting interfaces...') >= 0) {
          this.logger.info(`Conductor '${name}' process spawning successful`)
          resolve(handle)
        }
      })
    })
  }
}