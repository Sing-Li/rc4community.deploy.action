const {NodeSSH} = require('node-ssh')
const core = require('@actions/core')
const fs = require('node:fs/promises')
const {F_OK} = require('node:fs').constants
const path = require('node:path')

module.exports = class {
  constructor() {
    this.sshConfig = {
      host: process.env.REMOTE_HOST || core.getInput('remote_host'),
      port: process.env.REMOTE_PORT || core.getInput('remote_port') || 22,
      username: process.env.REMOTE_USER || core.getInput('remote_user') || 'root',
      privateKey: process.env.SSH_PRIVATE_KEY || core.getInput('ssh_private_key')
    }
    this.source = process.env.SOURCE || core.getInput('source')
    this.destination = process.env.TARGET || core.getInput('target')
    this.ssh = new NodeSSH()
  }

  async init() {
    if (!this.destination.startsWith('/')) {
      // oh no
      const home = await this.ssh.exec('sh', ['-c', 'printf $HOME'], {stream: 'stdout'})
      if (!home) throw new Error('failed to get remote HOME')
      this.destination = path.join(home, this.destination)
    }

    if (
      this.destination.endsWith('/') ||
      (await this.exec(`sh -c 'test -d ${this.destination}'`)) === 0
    ) {
      this.destinationDir = this.destination
      this.destination = path.join(this.destination, path.basename(this.source))
      return
    }

    this.destinationDir = path.dirname(this.destination)
  }

  /* prettier-ignore */
  async verifySourceExists() { await fs.access(this.source, F_OK) }

  async exec(cmd, execOptions) {
    execOptions = {
      /* prettier-ignore */
      onStdout(c) { process.stdout.write(c.toString('utf-8')) },
      /* prettier-ignore */
      onStderr(c) { process.stderr.write(c.toString('utf-8')) },
      cwd: this.destinationDir,
      ...execOptions
    }
    const {code} = await this.ssh.execCommand(cmd, execOptions)
    return code
  }

  async confirmRemoteLocExists() {
    if (await this.exec(`mkdir -pv ${this.destinationDir}`, {cwd: '/'}))
      throw new Error('failed to  create destination directory on remote server')
  }

  async remoteExtract() {
    if (!(await this.ssh.exec('which', ['tar'], {stream: 'stdout'})))
      throw new Error(
        'no tar binary found on remote server; please make sure it is installed for the action to work'
      )

    const extractCommand = `tar zxvf ${this.destination}`

    const keepArchive =
      process.env.KEEP_ARCHIVE || core.getInput('keep_archive')
        ? `mv -v ${this.destination} ${this.destination}-${new Date().toString()}`
        : `rm -vf ${this.destination}`

    if (await this.exec(`${extractCommand} && ${keepArchive}`))
      throw new Error('archive extract failed')
  }

  async startService() {
    const installPossibleNewDeps = '. ~/.nvm/nvm.sh && npm install --production --force'
    const startPm2ServiceThingy = 'pm2 reload ecosystem.config.js'
    if (await this.exec(`${installPossibleNewDeps} && ${startPm2ServiceThingy}`))
      throw new Error('deployment failed')
  }

  async run() {
    try {
      await this.ssh.connect(this.sshConfig)
      core.info('connected to remote host ..')

      await this.init()
      core.info('initialization complete')

      core.debug(`source file: ${this.source}, destination: ${this.destination}`)
      // am i alright papa?
      await this.verifySourceExists()
      await this.confirmRemoteLocExists()

      await this.ssh.putFile(this.source, this.destination)
      core.info(`file ${path.basename(this.source)} sent successfully`)

      await this.remoteExtract()
      core.info('archive successfully extracted and deleted')

      await this.startService()
      core.info('successfully deployed')
    } catch (e) {
      core.setFailed(e)
      process.abort()
    }

    this.ssh.dispose()
  }
}
