import { logger } from '@libp2p/logger'
import errCode from 'err-code'
import * as multistream from './multistream.js'
import { handshake } from 'it-handshake'
import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string'
import { PROTOCOL_ID } from './index.js'
import type { Duplex } from 'it-stream-types'
import { Uint8ArrayList } from 'uint8arraylist'
import { pushable } from 'it-pushable'
import merge from 'it-merge'
import { reader } from 'it-reader'
import type { ByteArrayInit, ByteListInit, MultistreamSelectInit, ProtocolStream } from './index.js'

const log = logger('libp2p:mss:select')

export async function select (stream: Duplex<Uint8Array>, protocols: string | string[], options: ByteArrayInit): Promise<ProtocolStream<Uint8Array>>
export async function select (stream: Duplex<Uint8ArrayList, Uint8ArrayList | Uint8Array>, protocols: string | string[], options?: ByteListInit): Promise<ProtocolStream<Uint8ArrayList, Uint8ArrayList | Uint8Array>>
export async function select (stream: Duplex<any>, protocols: string | string[], options: MultistreamSelectInit = {}): Promise<ProtocolStream<any>> {
  protocols = Array.isArray(protocols) ? [...protocols] : [protocols]
  const { reader, writer, rest, stream: shakeStream } = handshake(stream)

  const protocol = protocols.shift()

  if (protocol == null) {
    throw new Error('At least one protocol must be specified')
  }

  log('select: write ["%s", "%s"]', PROTOCOL_ID, protocol)
  const p1 = uint8ArrayFromString(PROTOCOL_ID)
  const p2 = uint8ArrayFromString(protocol)
  multistream.writeAll(writer, [p1, p2], options)

  let response = await multistream.readString(reader, options)
  log('select: read "%s"', response)

  // Read the protocol response if we got the protocolId in return
  if (response === PROTOCOL_ID) {
    response = await multistream.readString(reader, options)
    log('select: read "%s"', response)
  }

  // We're done
  if (response === protocol) {
    rest()
    return { stream: shakeStream, protocol }
  }

  // We haven't gotten a valid ack, try the other protocols
  for (const protocol of protocols) {
    log('select: write "%s"', protocol)
    multistream.write(writer, uint8ArrayFromString(protocol), options)
    const response = await multistream.readString(reader, options)
    log('select: read "%s" for "%s"', response, protocol)

    if (response === protocol) {
      rest() // End our writer so others can start writing to stream
      return { stream: shakeStream, protocol }
    }
  }

  rest()
  throw errCode(new Error('protocol selection failed'), 'ERR_UNSUPPORTED_PROTOCOL')
}

/**
 * Lazily negotiates a protocol.
 *
 * It *does not* block writes waiting for the other end to respond. Instead, it
 * simply assumes the negotiation went successfully and starts writing data.
 *
 * Use when it is known that the receiver supports the desired protocol.
 */
export function lazySelect (stream: Duplex<Uint8Array>, protocol: string): ProtocolStream<Uint8Array>
export function lazySelect (stream: Duplex<Uint8ArrayList, Uint8ArrayList | Uint8Array>, protocol: string): ProtocolStream<Uint8ArrayList, Uint8ArrayList | Uint8Array>
export function lazySelect (stream: Duplex<any>, protocol: string): ProtocolStream<any> {
  // This is a signal to write the multistream headers if the consumer tries to
  // read from the source
  const negotiateTrigger = pushable()
  let negotiated = false
  return {
    stream: {
      sink: async source => await stream.sink((async function * () {
        let first = true
        for await (const chunk of merge(source, negotiateTrigger)) {
          if (first) {
            first = false
            negotiated = true
            negotiateTrigger.end()
            const p1 = uint8ArrayFromString(PROTOCOL_ID)
            const p2 = uint8ArrayFromString(protocol)
            const list = new Uint8ArrayList(multistream.encode(p1), multistream.encode(p2))
            if (chunk.length > 0) list.append(chunk)
            yield * list
          } else {
            yield chunk
          }
        }
      })()),
      source: (async function * () {
        if (!negotiated) negotiateTrigger.push(new Uint8Array())
        const byteReader = reader(stream.source)
        let response = await multistream.readString(byteReader)
        if (response === PROTOCOL_ID) {
          response = await multistream.readString(byteReader)
        }
        if (response !== protocol) {
          throw errCode(new Error('protocol selection failed'), 'ERR_UNSUPPORTED_PROTOCOL')
        }
        for await (const chunk of byteReader) {
          yield * chunk
        }
      })()
    },
    protocol
  }
}
