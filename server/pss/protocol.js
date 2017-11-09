// @flow

import { isObject, isString } from 'lodash'

import type { ActionState, ID, MessageBlock, Profile } from '../data/db'
import { decodeMessage, encodeMessage, createKey } from '../lib'
import type { ByteArray } from './types'

const NONCE_SIZE = 8
const receivedNonces: Set<string> = new Set()

export type ProtocolType =
  | 'ACTION_STATE' // In channel or p2p topic
  | 'CHANNEL_INVITE' // In p2p topic
  | 'CONTACT_REQUEST' // In contact topic
  | 'PROFILE_REQUEST' // In channel
  | 'PROFILE_RESPONSE' // In channel
  | 'TOPIC_JOINED' // In channel or p2p topic
  | 'TOPIC_MESSAGE' // In channel or p2p topic
  | 'TOPIC_TYPING' // In channel or p2p topic

export type ActionStatePayload = {
  id: ID,
  state: ActionState,
}

export type PeerInfo = {
  address: string,
  pubKey: ID,
}

export type ChannelInvitePayload = {
  topic: ByteArray,
  subject: string,
  peers: Array<PeerInfo>,
  dark: boolean,
}

export type ContactRequestPayload = {
  address: string,
  profile: Profile,
  topic: ByteArray,
}

export type ProfileResponsePayload = {
  profile: Profile,
}

export type TopicJoinedPayload = {
  address: string,
  profile?: ?Profile,
}

export type TopicMessagePayload = {
  blocks: Array<MessageBlock>,
}

export type TopicTypingPayload = {
  typing: boolean,
}

export type ProtocolPayload =
  | ActionStatePayload
  | ChannelInvitePayload
  | ContactRequestPayload
  | ProfileResponsePayload
  | TopicJoinedPayload
  | TopicMessagePayload
  | TopicTypingPayload

export type ProtocolEvent<T = ProtocolType, P = ProtocolPayload> = {
  type: T,
  payload: P,
}

export type ReceivedEvent = ProtocolEvent<*, *> & {
  sender: ID,
}

export const decodeProtocol = (msg: string): ?ProtocolEvent<*, *> => {
  try {
    const envelope = JSON.parse(msg)
    if (
      isObject(envelope) &&
      envelope.nonce != null &&
      isObject(envelope.payload) &&
      isString(envelope.payload.type)
    ) {
      if (receivedNonces.has(envelope.nonce)) {
        console.warn('Duplicate message:', envelope)
      } else {
        receivedNonces.add(envelope.nonce)
        return envelope.payload
      }
    } else {
      console.warn('Unrecognised message format:', envelope)
    }
  } catch (err) {
    console.warn('Failed to decode protocol message:', msg, err)
  }
}

export const encodeProtocol = (data: ProtocolEvent<*, *>) => {
  const envelope = {
    nonce: createKey(NONCE_SIZE, true),
    payload: data,
  }
  return encodeMessage(JSON.stringify(envelope))
}

export type ActionStateEvent = ProtocolEvent<'ACTION_STATE', ActionStatePayload>

export const actionState = (id: ID, state: ActionState): ActionStateEvent => ({
  type: 'ACTION_STATE',
  payload: { id, state },
})

export type ChannelInviteEvent = ProtocolEvent<
  'CHANNEL_INVITE',
  ChannelInvitePayload,
>

export const channelInvite = (
  payload: ChannelInvitePayload,
): ChannelInviteEvent => ({
  type: 'CHANNEL_INVITE',
  payload,
})

export type ContactRequestEvent = ProtocolEvent<
  'CONTACT_REQUEST',
  ContactRequestPayload,
>

export const contactRequest = (
  payload: ContactRequestPayload,
): ContactRequestEvent => ({
  type: 'CONTACT_REQUEST',
  payload,
})

export type ProfileRequestEvent = ProtocolEvent<'PROFILE_REQUEST'>

export const profileRequest = (): ProfileRequestEvent => ({
  type: 'PROFILE_REQUEST',
  payload: {},
})

export type ProfileResponseEvent = ProtocolEvent<
  'PROFILE_RESPONSE',
  ProfileResponsePayload,
>

export const profileResponse = (profile: Profile): ProfileResponseEvent => ({
  type: 'PROFILE_RESPONSE',
  payload: { profile },
})

export type TopicJoinedEvent = ProtocolEvent<'TOPIC_JOINED', TopicJoinedPayload>

export const topicJoined = (
  profile: ?Profile,
  address?: string = '',
): TopicJoinedEvent => ({
  type: 'TOPIC_JOINED',
  payload: { address, profile },
})

export type TopicMessageEvent = ProtocolEvent<
  'TOPIC_MESSAGE',
  TopicMessagePayload,
>

export const topicMessage = (
  payload: TopicMessagePayload,
): TopicMessageEvent => ({
  type: 'TOPIC_MESSAGE',
  payload,
})

export type TopicTypingEvent = ProtocolEvent<'TOPIC_TYPING', TopicTypingPayload>

export const topicTyping = (typing: boolean): TopicTypingEvent => ({
  type: 'TOPIC_TYPING',
  payload: { typing },
})
