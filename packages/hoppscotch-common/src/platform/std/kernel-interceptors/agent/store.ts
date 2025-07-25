import { Service } from "dioc"
import { ref } from "vue"
import * as E from "fp-ts/Either"
import axios from "axios"
import { Store } from "~/kernel/store"
import type { PluginRequest, PluginResponse } from "@hoppscotch/kernel"
import { x25519 } from "@noble/curves/ed25519"
import { base16 } from "@scure/base"
import {
  InputDomainSetting,
  convertDomainSetting,
} from "~/helpers/functional/domain-settings"

const STORE_NAMESPACE = "interceptors.agent.v1"

const STORE_KEYS = {
  SETTINGS: "settings",
} as const

interface StoredData {
  version: string
  auth: {
    key: string | null
    sharedSecret: string | null
  }
  domains: Record<string, InputDomainSetting>
  lastUpdated: string
}

const defaultDomainConfig: InputDomainSetting = {
  version: "v1",
  security: {
    verifyHost: true,
    verifyPeer: true,
  },
  proxy: undefined,
}

export class KernelInterceptorAgentStore extends Service {
  public static readonly ID = "AGENT_INTERCEPTOR_STORE"
  private static readonly GLOBAL_DOMAIN = "*"
  private static readonly DEFAULT_GLOBAL_SETTINGS: InputDomainSetting = {
    ...defaultDomainConfig,
    version: "v1",
  }

  private domainSettings = new Map<string, InputDomainSetting>()

  public isAgentRunning = ref(false)
  public authKey = ref<string | null>(null)
  private sharedSecretB16 = ref<string | null>(null)

  // AgentSubtitle component shared variables for unified display across multiple components
  public hasInitiatedRegistration = ref(false)
  public maskedAuthKey = ref("")
  public hasCheckedAgent = ref(false)
  public registrationOTP = ref(this.authKey.value ? null : "")
  public isRegistering = ref(false)

  override async onServiceInit() {
    const initResult = await Store.init()
    if (E.isLeft(initResult)) {
      console.error("[AgentStore] Failed to initialize store:", initResult.left)
      return
    }

    await this.loadStore()
    this.setupWatchers()
  }

  private async loadStore(): Promise<void> {
    const loadResult = await Store.get<StoredData>(
      STORE_NAMESPACE,
      STORE_KEYS.SETTINGS
    )

    if (E.isRight(loadResult) && loadResult.right) {
      const store = loadResult.right
      this.domainSettings = new Map(Object.entries(store.domains))
      this.authKey.value = store.auth.key
      this.sharedSecretB16.value = store.auth.sharedSecret
    }

    if (!this.domainSettings.has(KernelInterceptorAgentStore.GLOBAL_DOMAIN)) {
      this.domainSettings.set(
        KernelInterceptorAgentStore.GLOBAL_DOMAIN,
        KernelInterceptorAgentStore.DEFAULT_GLOBAL_SETTINGS
      )
      await this.persistStore()
    }
  }

  private async setupWatchers() {
    const watcher = await Store.watch(STORE_NAMESPACE, STORE_KEYS.SETTINGS)
    watcher.on("change", async ({ value }) => {
      if (value) {
        const store = value as StoredData
        this.domainSettings = new Map(Object.entries(store.domains))
        this.authKey.value = store.auth.key
        this.sharedSecretB16.value = store.auth.sharedSecret
      }
    })
  }

  private async persistStore(): Promise<void> {
    const store: StoredData = {
      version: "v1",
      auth: {
        key: this.authKey.value,
        sharedSecret: this.sharedSecretB16.value,
      },
      domains: Object.fromEntries(this.domainSettings),
      lastUpdated: new Date().toISOString(),
    }

    const saveResult = await Store.set(
      STORE_NAMESPACE,
      STORE_KEYS.SETTINGS,
      store
    )
    if (E.isLeft(saveResult)) {
      console.error("[AgentStore] Failed to save store:", saveResult.left)
    }
  }

  public async resetAuthKey(): Promise<void> {
    this.authKey.value = null
    this.sharedSecretB16.value = null
    await this.persistStore()
  }

  private mergeSecurity(
    ...settings: (Required<InputDomainSetting>["security"] | undefined)[]
  ): Required<InputDomainSetting>["security"] | undefined {
    return settings.reduce(
      (acc, setting) => (setting ? { ...acc, ...setting } : acc),
      undefined as Required<InputDomainSetting>["security"] | undefined
    )
  }

  private mergeProxy(
    ...settings: (Required<InputDomainSetting>["proxy"] | undefined)[]
  ): Required<InputDomainSetting>["proxy"] | undefined {
    return settings.reduce(
      (acc, setting) => (setting ? { ...acc, ...setting } : acc),
      undefined as Required<InputDomainSetting>["proxy"] | undefined
    )
  }

  private getMergedSettings(domain: string): InputDomainSetting {
    const domainSettings = this.domainSettings.get(domain)
    const globalSettings =
      domain !== KernelInterceptorAgentStore.GLOBAL_DOMAIN
        ? this.domainSettings.get(KernelInterceptorAgentStore.GLOBAL_DOMAIN)
        : undefined

    const result = {
      security: this.mergeSecurity(
        globalSettings?.security,
        domainSettings?.security
      ),
      proxy: this.mergeProxy(globalSettings?.proxy, domainSettings?.proxy),
    }

    return { version: "v1", ...result }
  }

  public completeRequest(
    request: Omit<PluginRequest, "proxy" | "security">
  ): PluginRequest {
    const host = new URL(request.url).host
    const settings = this.getMergedSettings(host)
    const effective = convertDomainSetting(settings)

    if (E.isLeft(effective)) {
      throw effective.left
    }

    return { ...request, ...effective.right }
  }

  public async checkAgentStatus(): Promise<void> {
    try {
      const handshakeResponse = await axios.get(
        "http://localhost:9119/handshake"
      )
      this.isAgentRunning.value =
        handshakeResponse.data.status === "success" &&
        handshakeResponse.data.__hoppscotch__agent__ === true
    } catch {
      this.isAgentRunning.value = false
    }
  }

  public isAuthKeyPresent(): boolean {
    return this.authKey.value !== null
  }

  public async initiateRegistration() {
    const otp = Math.floor(100000 + Math.random() * 900000).toString()

    const response = await axios.post(
      "http://localhost:9119/receive-registration",
      { registration: otp }
    )

    if (response.data.message !== "Registration received and stored") {
      throw new Error(response.data.message ?? "Registration failed")
    }

    return otp
  }

  public async verifyRegistration(otp: string): Promise<void> {
    const myPrivateKey = x25519.utils.randomPrivateKey()
    const myPublicKey = x25519.getPublicKey(myPrivateKey)
    const myPublicKeyB16 = base16.encode(myPublicKey).toLowerCase()

    const response = await axios.post(
      "http://localhost:9119/verify-registration",
      {
        registration: otp,
        client_public_key_b16: myPublicKeyB16,
      }
    )

    const { auth_key: newAuthKey, agent_public_key_b16: agentPublicKeyB16 } =
      response.data

    if (typeof newAuthKey !== "string")
      throw new Error("Invalid auth key received")

    const agentPublicKey = base16.decode(agentPublicKeyB16.toUpperCase())
    const sharedSecret = x25519.getSharedSecret(myPrivateKey, agentPublicKey)
    const sharedSecretB16 = base16.encode(sharedSecret).toLowerCase()

    this.authKey.value = newAuthKey
    this.sharedSecretB16.value = sharedSecretB16
    await this.persistStore()
  }

  public async fetchRegistrationInfo(): Promise<{
    registered_at: Date
    auth_key_hash: string
  }> {
    try {
      const response = await axios.get("http://localhost:9119/registration", {
        headers: {
          Authorization: `Bearer ${this.authKey.value}`,
        },
        responseType: "arraybuffer",
      })

      const nonceB16 = response.headers["x-hopp-nonce"]
      if (!nonceB16) {
        throw new Error("No nonce received from server")
      }

      return await this.decryptResponse(nonceB16, response.data)
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 401) {
          this.authKey.value = null
          await this.persistStore()
        }
      }
      throw error
    }
  }

  public async encryptRequest(
    request: PluginRequest,
    reqID: number
  ): Promise<[string, ArrayBuffer]> {
    const reqJSON = JSON.stringify({ ...request, id: reqID })
    const reqJSONBytes = new TextEncoder().encode(reqJSON)
    const nonce = window.crypto.getRandomValues(new Uint8Array(12))
    const nonceB16 = base16.encode(nonce).toLowerCase()

    const sharedSecretKeyBytes = base16.decode(
      this.sharedSecretB16.value!.toUpperCase()
    )
    const sharedSecretKey = await window.crypto.subtle.importKey(
      "raw",
      sharedSecretKeyBytes,
      "AES-GCM",
      true,
      ["encrypt", "decrypt"]
    )

    const encryptedReq = await window.crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      sharedSecretKey,
      reqJSONBytes
    )

    return [nonceB16, encryptedReq]
  }

  public async decryptResponse(
    nonceB16: string,
    encryptedResponse: ArrayBuffer
  ): Promise<PluginResponse> {
    const nonce = base16.decode(nonceB16.toUpperCase())
    const sharedSecretKeyBytes = base16.decode(
      this.sharedSecretB16.value!.toUpperCase()
    )

    const sharedSecretKey = await window.crypto.subtle.importKey(
      "raw",
      sharedSecretKeyBytes,
      "AES-GCM",
      true,
      ["encrypt", "decrypt"]
    )

    const decryptedBytes = await window.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce },
      sharedSecretKey,
      encryptedResponse
    )

    return JSON.parse(new TextDecoder().decode(decryptedBytes))
  }

  public async cancelRequest(reqId: number): Promise<void> {
    try {
      await axios.post(
        `http://localhost:9119/cancel/${reqId}`,
        {},
        {
          headers: {
            Authorization: `Bearer ${this.authKey.value}`,
          },
        }
      )
    } catch (error) {
      console.error("Error cancelling request:", error)
    }
  }

  public getDomainSettings(domain: string): InputDomainSetting {
    return (
      this.domainSettings.get(domain) ?? {
        ...defaultDomainConfig,
        version: "v1",
      }
    )
  }

  public async saveDomainSettings(
    domain: string,
    settings: Partial<InputDomainSetting>
  ): Promise<void> {
    const updatedSettings: InputDomainSetting = {
      ...settings,
      version: "v1",
    }

    this.domainSettings.set(domain, updatedSettings)
    await this.persistStore()
  }

  public async clearDomainSettings(domain: string): Promise<void> {
    this.domainSettings.delete(domain)
    await this.persistStore()
  }

  public getDomains(): string[] {
    return Array.from(this.domainSettings.keys())
  }

  public getAllDomainSettings(): Map<string, InputDomainSetting> {
    return new Map(this.domainSettings)
  }
}
