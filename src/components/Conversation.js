// @flow

import 'draft-js/dist/Draft.css'
import 'react-virtualized/styles.css'

import bytes from 'bytes'
import { Editor, EditorState } from 'draft-js'
import { groupBy, throttle } from 'lodash'
import Moment from 'moment'
import PropTypes from 'prop-types'
import React, { Component, type Element } from 'react'
import { compose, gql, graphql, type ApolloClient } from 'react-apollo'
import { StyleSheet, View, TouchableOpacity } from 'react-native-web'

import {
  AutoSizer,
  CellMeasurer,
  CellMeasurerCache,
  List as VirtualizedList,
  type RowRendererParams,
} from 'react-virtualized'

import { MessageData, ProfileData } from '../graphql/fragments'
import {
  SendMessageMutation,
  SetTypingMutation,
  UpdatePointerMutation,
  ResendInvitesMutation,
  type SendMessageFunc,
  type SetTypingFunc,
  type UpdatePointerFunc,
  type ResendInvitesFunc,
} from '../graphql/mutations'

import Loader from './Loader'
import Avatar, { AVATAR_SIZE } from './Avatar'
import Text from './Text'
import UserProfileModal from './UserProfileModal'
import Icon from './Icon'

import FileSelector from './FileSelector'

import COLORS from '../colors'
import { BASIC_SPACING } from '../styles'

type File = {
  hash: string,
  mimeType: string,
  name: string,
  size: number,
}

type FileBlock = {
  file: File,
}

type TextBlock = {
  text: string,
}

type Profile = {
  id: string,
  avatar: ?string,
  bio: ?string,
  name: ?string,
}

type MessageProps = {
  hasPointer: boolean,
  isSender: boolean,
  message: {
    blocks: Array<FileBlock | TextBlock>,
    timestamp: number,
  },
  profile: Profile,
  dark: boolean,
  ownProfileID: string,
  getPeer: (id: string) => ?{ profile: Profile },
  onPressProfile: (profile: Profile) => void,
}

const SUPPORTED_FILE_ICONS = {
  'application/pdf': 'pdf',
}

class MessageRow extends Component<MessageProps> {
  static contextTypes = {
    httpServerUrl: PropTypes.string.isRequired,
  }

  render() {
    const {
      isSender,
      message,
      onPressProfile,
      profile,
      dark,
      hasPointer,
    } = this.props
    const sender = isSender ? 'You' : profile.name || profile.id.substr(0, 8)
    const time = Moment(message.timestamp)
    const blocks = groupBy(message.blocks, '__typename')

    const textStyles = [styles.textStyles]
    if (dark) {
      textStyles.push(styles.whiteText)
    }

    let messageBody = null
    const file =
      blocks.MessageBlockFile &&
      blocks.MessageBlockFile[0] && // $FlowFixMe
      blocks.MessageBlockFile[0].file

    const onPressFile = file
      ? () => {
          document.location.href = `${this.context.httpServerUrl}/bzzr:/${
            file.hash
          }`
        }
      : null

    const fileNameStyles = dark
      ? [styles.fileDownloadName, styles.whiteText]
      : styles.fileDownloadName

    const fileBlock = file ? (
      file.mimeType.substr(0, 5) === 'image' ? (
        <TouchableOpacity onPress={onPressFile}>
          <View style={styles.messageImage}>
            <img
              alt={file.name}
              src={`${this.context.httpServerUrl}/bzzr:/${file.hash}`}
              className="message-image"
            />
          </View>
        </TouchableOpacity>
      ) : (
        <TouchableOpacity onPress={onPressFile} style={styles.fileDownload}>
          <Icon name={SUPPORTED_FILE_ICONS[file.mimeType] || 'generic-file'} />
          <View style={styles.fileDownloadText}>
            <Text style={fileNameStyles} numberOfLines={1}>
              {file.name}
            </Text>
            <Text style={styles.fileDownloadSize}>{bytes(file.size)}</Text>
          </View>
          <Icon name="download" />
        </TouchableOpacity>
      )
    ) : null

    let textBlock = null
    const text =
      blocks.MessageBlockText && // $FlowFixMe
      blocks.MessageBlockText.map(b => b.text).join('\n')
    if (text != null) {
      textBlock = <Text style={textStyles}>{text}</Text>
    }

    const openProfile = () => {
      onPressProfile(profile)
    }

    messageBody = (
      <View style={styles.message}>
        <TouchableOpacity onPress={openProfile} style={styles.messageAvatar}>
          <Avatar profile={profile} size="large" />
        </TouchableOpacity>
        <View style={styles.messageBody}>
          <View style={styles.messageProfile}>
            <TouchableOpacity onPress={openProfile}>
              <Text style={styles.messageSender}>{sender}</Text>
            </TouchableOpacity>
            <Text style={styles.messageTime}>{time.calendar()}</Text>
          </View>
          {textBlock}
          {fileBlock}
        </View>
      </View>
    )

    const newMsgStyles = [styles.newMessagesText]
    if (dark) {
      newMsgStyles.push(styles.newMessagesTextDark)
    }

    const pointer = hasPointer ? (
      <View style={styles.newMessages}>
        <Text style={newMsgStyles}>new messages</Text>
      </View>
    ) : null

    return (
      <View style={styles.messageContainer}>
        {pointer}
        {messageBody}
      </View>
    )
  }
}

type UnsubscribeFunc = () => void
type SubscribeFunc = (id: string) => UnsubscribeFunc

type Props = {
  data: Object,
  id: string,
  sendMessage: SendMessageFunc,
  setTyping: SetTypingFunc,
  updatePointer: UpdatePointerFunc,
  resendInvites: ResendInvitesFunc,
  subscribeToMessageAdded: SubscribeFunc,
  subscribeToTypingsChanged: SubscribeFunc,
}

type Context = {
  client: ApolloClient,
  wsConnected$: Object,
}

type State = {
  editorState: EditorState,
  file: ?File,
  typingText: string,
  openProfile: ?Object,
}

class Conversation extends Component<Props, State> {
  static contextTypes = {
    client: PropTypes.object.isRequired,
    wsConnected$: PropTypes.object.isRequired,
    httpServerUrl: PropTypes.string.isRequired,
  }

  firstPointer: ?number
  notRendered: boolean = true
  onBottom: ?boolean
  fileSelector: ?Element<typeof FileSelector>
  editor: ?Element<typeof Editor>
  list: ?Element<typeof VirtualizedList>
  typing: boolean = false
  typingTimer: ?number
  unsubscribeMessageAdded: ?UnsubscribeFunc
  unsubscribeTypingsChanged: ?UnsubscribeFunc

  cache: CellMeasurerCache

  constructor(props: Props, context: Context) {
    super(props, context)

    this.state = {
      editorState: EditorState.createEmpty(),
      file: undefined,
      typingText: '',
      openProfile: null,
    }

    this.cache = new CellMeasurerCache({
      defaultHeight: 100,
      fixedWidth: true,
    })

    this.setFirstPointer(props)
  }

  setFirstPointer = (props: Props) => {
    this.firstPointer =
      props.data &&
      props.data.conversation &&
      props.data.conversation.pointer > 0 &&
      props.data.conversation.pointer < props.data.conversation.messages.length
        ? props.data.conversation.pointer
        : -1
  }

  bindFileSelector = (fileSelector: ?Element<typeof FileSelector>) => {
    this.fileSelector = fileSelector
  }

  bindEditor = (editor: ?Element<typeof Editor>) => {
    this.editor = editor
    this.focusEditor()
  }

  bindList = (list: ?Element<typeof VirtualizedList>) => {
    this.list = list
  }

  componentWillReceiveProps(nextProps) {
    if (nextProps.data && !this.unsubscribeMessageAdded) {
      this.unsubscribeMessageAdded = this.props.subscribeToMessageAdded(
        this.props.id,
      )
      this.unsubscribeTypingsChanged = this.context.client
        .subscribe({
          query: gql`
            ${ProfileData}
            subscription TypingsChangedSubscription($id: ID!) {
              typingsChanged(id: $id) {
                ...ProfileData
              }
            }
          `,
          variables: { id: this.props.id },
        })
        .subscribe({
          next: ({ typingsChanged }) => {
            const toBe = typingsChanged.length > 1 ? 'are' : 'is'
            const typingText =
              typingsChanged.length > 0
                ? typingsChanged
                    .map(p => p.name || p.id.substr(0, 8))
                    .join(' and ') + ` ${toBe} typing`
                : ''
            this.setState(
              s => (s.typingText === typingText ? null : { typingText }),
            )
          },
        }).unsubscribe
    }
  }

  componentWillUnmount() {
    if (this.typingTimer != null) {
      clearTimeout(this.typingTimer)
    }
    if (this.context.wsConnected$.value && this.unsubscribeMessageAdded) {
      this.unsubscribeMessageAdded()
      this.unsubscribeTypingsChanged()
    }
  }

  componentDidUpdate(prevProps: Props) {
    //First time getting the conversation
    if (
      (prevProps.data && !prevProps.data.conversation) &&
      this.props.data.conversation
    ) {
      this.setFirstPointer(this.props)
      this.focusEditor()
    }
  }

  focusEditor = () => {
    if (this.editor) {
      // $FlowIgnore
      this.editor.focus()
    }
  }

  onDragOver = (event: SyntheticDragEvent<HTMLHeadingElement>) => {
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
  }

  onDrop = (event: SyntheticDragEvent<HTMLHeadingElement>) => {
    event.preventDefault()
    event.stopPropagation()
    // Only handle a single file for now
    const file = event.dataTransfer.files[0]
    if (file) {
      this.sendFile(file)
    }
  }

  addFile = () => {
    // $FlowFixMe
    this.fileSelector && this.fileSelector.openFileSelector()
  }

  onFilesSelected = (files: Array<Object>) => {
    if (files.length) {
      this.sendFile(files[0])
    }
    this.focusEditor()
  }

  sendFile = (file: Object) => {
    const reader = new FileReader()
    reader.onload = async e => {
      const res = await fetch(`${this.context.httpServerUrl}/bzzr:`, {
        body: e.currentTarget.result,
        headers: {
          'Content-Length': file.size,
          'Content-Type': file.type,
        },
        method: 'POST',
      })
      this.setState({
        file: {
          hash: await res.text(),
          mimeType: file.type,
          name: file.name,
          size: file.size,
        },
      })
    }
    reader.readAsArrayBuffer(file)
  }

  onEditorChange = (editorState: EditorState) => {
    this.setState({ editorState }, () => {
      this.toggleTyping(
        this.state.editorState.getCurrentContent().getPlainText().length > 0,
      )
    })
  }

  setTyping = throttle(() => {
    this.props.setTyping({ convoID: this.props.id, typing: true })
    setTimeout(this.clearTyping, 2000)
  }, 500)

  clearTyping = () => {
    this.typing = false
    this.props.setTyping({ convoID: this.props.id, typing: false })
  }

  toggleTyping = (typing: boolean) => {
    if (typing === this.typing) {
      return
    }
    this.typing = typing
    const hasTyping = this.typingTimer != null
    if (hasTyping) {
      clearTimeout(this.typingTimer)
      this.typingTimer = undefined
    }
    if (typing) {
      this.setTyping()
    } else if (hasTyping) {
      this.clearTyping()
    }
  }

  sendMessage = () => {
    const { editorState, file } = this.state
    const text = editorState.getCurrentContent().getPlainText()
    const blocks = []
    if (text.length > 0) {
      blocks.push({ text })
    }
    if (file != null) {
      blocks.push({ file })
    }

    if (blocks.length > 0) {
      this.props.sendMessage({ blocks, convoID: this.props.id })
      // Reset input
      this.setState(
        {
          editorState: EditorState.createEmpty(),
          file: undefined,
        },
        () => {
          // $FlowFixMe
          this.focusEditor()
        },
      )
    }
  }

  handleReturn = (e: SyntheticKeyboardEvent<*>) => {
    const hasModifier = e.altKey || e.ctrlKey || e.metaKey || e.shiftKey
    if (hasModifier) {
      return 'not-handled'
    } else {
      this.sendMessage()
      return 'handled'
    }
  }

  onPressResendInvites = () => {
    this.props.resendInvites(this.props.id)
  }

  // TODO: better way to retrieve peers, they could be stored in a Map
  getPeer = (id: string): Object => {
    const { data } = this.props
    if (id === data.viewer.profile.id) {
      return data.viewer
    }
    return data.conversation.peers.find(c => c.profile.id === id)
  }

  renderRow = ({ index, key, parent, style, isVisible }: RowRendererParams) => {
    const { data } = this.props
    if (isVisible && index === data.conversation.messages.length - 1) {
      this.onBottom = true
      if (data.conversation.pointer < data.conversation.messages.length) {
        this.props.updatePointer(this.props.id)
      }
    }

    let contents = null
    const message = data.conversation.messages[index]
    if (message != null) {
      const peer = message.sender && this.getPeer(message.sender)
      if (peer != null) {
        contents = (
          <CellMeasurer
            cache={this.cache}
            columnIndex={0}
            key={key}
            parent={parent}
            rowIndex={index}
          >
            <MessageRow
              dark={data.conversation.dark}
              hasPointer={index === this.firstPointer}
              isSender={peer.profile.id === data.viewer.profile.id}
              message={message}
              profile={peer.profile}
              onPressProfile={this.showProfile}
            />
          </CellMeasurer>
        )
      } else {
        console.warn('Peer not found for message', message)
      }
    }

    return (
      <div key={key} style={style}>
        {contents}
      </div>
    )
  }

  showProfile = (openProfile: Object) => {
    this.setState({ openProfile })
  }

  hideProfile = () => {
    this.setState({ openProfile: null })
  }

  renderProfileModal() {
    const { openProfile } = this.state

    return openProfile ? (
      <UserProfileModal profile={openProfile} onCloseModal={this.hideProfile} />
    ) : null
  }

  showMyProfile = () => {
    this.showProfile(this.props.data.viewer.profile)
  }

  onScroll = ({
    clientHeight,
    scrollHeight,
    scrollTop,
  }: {
    clientHeight: number,
    scrollHeight: number,
    scrollTop: number,
  }) => {
    this.onBottom = clientHeight + scrollTop === scrollHeight
  }

  onRowsRendered = () => {
    this.notRendered = false
  }

  renderResendInvites = () => {
    return this.props.data.conversation.type === 'CHANNEL' ? (
      <TouchableOpacity
        style={styles.resendButton}
        onPress={this.onPressResendInvites}
      >
        <Text style={styles.resendText}>Resend Invites</Text>
      </TouchableOpacity>
    ) : null
  }

  render() {
    const { data } = this.props
    const { editorState, typingText, file } = this.state

    if (data == null || data.conversation == null) {
      return (
        <View style={styles.loaderContainer}>
          <Loader />
        </View>
      )
    }

    let subject = ''
    if (data.conversation.type === 'CHANNEL') {
      subject = `#${data.conversation.subject}`
    } else {
      const peerProfile =
        data.conversation.peers &&
        data.conversation.peers[0] &&
        data.conversation.peers[0].profile
      subject = peerProfile.name || peerProfile.id.substr(0, 8)
    }

    const containerStyles = [styles.container]
    const titleStyles = [styles.title]
    const inputStyles = [styles.input]
    const editorStyles = [styles.editor]
    const typingStyles = [styles.typingText]

    const fileIcon = file
      ? 'file-red'
      : data.conversation.dark ? 'file-dark' : 'file'

    if (data.conversation.dark) {
      containerStyles.push(styles.darkContainer)
      titleStyles.push(styles.whiteText)
      inputStyles.push(styles.darkInput)
      editorStyles.push(styles.editorDarkLine)
      typingStyles.push(styles.whiteText)
    }

    return (
      <View
        onDragOver={this.onDragOver}
        onDrop={this.onDrop}
        style={containerStyles}
      >
        {this.renderProfileModal()}
        <View style={styles.header}>
          <View>
            <View style={styles.titleArea}>
              <Text numberOfLines={1} style={titleStyles}>
                {subject}
              </Text>
              <View>
                <Icon
                  name={data.conversation.dark ? 'mask-blue' : 'flash-blue'}
                />
              </View>
            </View>

            <Text style={styles.subtitle}>
              {data.conversation.type === 'CHANNEL'
                ? 'Channel'
                : 'Direct Message'}
            </Text>
          </View>
          <View className="participants-list" style={styles.participants}>
            <TouchableOpacity
              onPress={this.showMyProfile}
              style={styles.avatar}
            >
              <Avatar profile={data.viewer.profile} />
            </TouchableOpacity>
            {data.conversation.peers.map(p => {
              const showProfile = () => {
                this.showProfile(p.profile)
              }
              return (
                <TouchableOpacity
                  key={p.profile.id}
                  onPress={showProfile}
                  style={styles.avatar}
                >
                  <Avatar profile={p.profile} />
                </TouchableOpacity>
              )
            })}
            {this.renderResendInvites()}
          </View>
        </View>
        <View style={styles.messages}>
          <AutoSizer>
            {({ width, height }) => (
              <VirtualizedList
                height={height}
                ref={this.bindList}
                rowCount={data.conversation.messages.length}
                overscanRowCount={40}
                deferredMeasurementCache={this.cache}
                rowHeight={this.cache.rowHeight}
                rowRenderer={this.renderRow}
                width={width}
                onScroll={this.onScroll}
                onRowsRendered={this.onRowsRendered}
                scrollToIndex={
                  this.notRendered || this.onBottom
                    ? data.conversation.pointer
                    : undefined
                }
              />
            )}
          </AutoSizer>
        </View>
        <View style={inputStyles}>
          <TouchableOpacity onPress={this.addFile} style={styles.inputButton}>
            <Icon name={fileIcon} />
          </TouchableOpacity>
          <View onClick={this.focusEditor} style={editorStyles}>
            <Editor
              editorState={editorState}
              handleReturn={this.handleReturn}
              onChange={this.onEditorChange}
              placeholder={`Message ${subject}`}
              //$FlowFixMe
              ref={this.bindEditor}
            />
          </View>
        </View>
        <View style={styles.typing}>
          <Text style={typingStyles} numberOfLines={1}>
            {file && (
              <Text style={styles.redText}>{`Press “enter” to send: ${
                file.name
              } `}</Text>
            )}
            {typingText}
          </Text>
        </View>
        <FileSelector
          onFilesSelected={this.onFilesSelected}
          //$FlowFixMe
          ref={this.bindFileSelector}
        />
      </View>
    )
  }
}

const styles = StyleSheet.create({
  loaderContainer: {
    flex: 1,
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
  },
  container: {
    flex: 1,
    flexDirection: 'column',
    height: '100vh',
  },
  darkContainer: {
    backgroundColor: COLORS.DARKEST_BLUE,
  },
  header: {
    borderBottomColor: COLORS.GRAY_E6,
    borderBottomStyle: 'solid',
    borderBottomWidth: 1,
    paddingVertical: 2 * BASIC_SPACING,
    marginHorizontal: 2 * BASIC_SPACING,
    marginBottom: BASIC_SPACING,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  title: {
    fontSize: 20,
    marginRight: BASIC_SPACING,
  },
  subtitle: {
    fontSize: 12,
    color: COLORS.LIGHTEST_BLUE,
    marginTop: BASIC_SPACING / -2,
  },
  titleArea: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  participants: {
    flexDirection: 'row',
    overflowX: 'auto',
    flex: '10 0 auto',
  },
  avatar: {
    marginLeft: BASIC_SPACING,
  },
  messages: {
    flex: 1,
  },
  message: {
    paddingHorizontal: 2 * BASIC_SPACING,
    flexDirection: 'row',
    paddingBottom: 2 * BASIC_SPACING,
  },
  messageAvatar: {
    marginRight: BASIC_SPACING,
    width: 48,
    alignItems: 'center',
  },
  messageProfile: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  messageBody: {
    flexDirection: 'column',
  },
  textStyles: {
    fontFamily: 'Muli',
    fontSize: 14,
    maxWidth: 'calc(100vw - 350px)',
  },
  messageSender: {
    color: COLORS.LIGHTEST_BLUE,
    fontSize: 14,
    fontWeight: '500',
  },
  messageTime: {
    marginLeft: BASIC_SPACING / 2,
    color: COLORS.MEDIUM_GRAY,
    fontSize: 10,
  },
  typing: {
    height: 25,
    paddingHorizontal: 2 * BASIC_SPACING,
    justifyContent: 'center',
    alignItems: 'flex-start',
  },
  typingText: {
    color: COLORS.GRAY_98,
    fontSize: 10,
  },
  input: {
    flexDirection: 'row',
    backgroundColor: COLORS.LIGHT_GRAY,
    padding: BASIC_SPACING + 4,
    marginHorizontal: 2 * BASIC_SPACING,
    marginTop: BASIC_SPACING,
    borderRadius: 5,
    alignItems: 'center',
  },
  inputButton: {
    marginRight: BASIC_SPACING,
  },
  darkInput: {
    backgroundColor: COLORS.WHITE,
  },
  editor: {
    flex: 1,
    borderLeftStyle: 'solid',
    borderLeftWidth: 1,
    borderLeftColor: COLORS.GRAY_D3,
    paddingLeft: BASIC_SPACING,
  },
  editorDarkLine: {
    borderLeftColor: COLORS.GRAY_57,
  },
  button: {
    justifyContent: 'flex-end',
  },
  whiteText: {
    color: COLORS.WHITE,
  },
  redText: {
    color: COLORS.PRIMARY_RED,
  },
  messageImage: {
    height: 200,
    marginTop: BASIC_SPACING,
    borderRadius: 5,
    overflow: 'hidden',
    justifyContent: 'center',
  },
  fileDownload: {
    width: 300,
    flexDirection: 'row',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: COLORS.RED,
    padding: BASIC_SPACING / 2,
    paddingRight: BASIC_SPACING * 2,
    borderRadius: 50,
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: BASIC_SPACING,
  },
  fileDownloadText: {
    flex: 1,
    flexDirection: 'column',
    paddingHorizontal: BASIC_SPACING,
  },
  fileDownloadName: {
    fontSize: 12,
    color: COLORS.GRAY_23,
  },
  fileDownloadSize: {
    fontSize: 10,
    color: COLORS.MEDIUM_GRAY,
  },
  peers: {
    marginBottom: 2 * BASIC_SPACING,
    maxWidth: 300,
  },
  newMessages: {
    borderBottomWidth: 1,
    borderBottomColor: COLORS.PRIMARY_RED,
    borderBottomStyle: 'dotted',
    marginBottom: 2 * BASIC_SPACING,
    marginHorizontal: 2 * BASIC_SPACING,
  },
  newMessagesText: {
    paddingHorizontal: 2 * BASIC_SPACING,
    color: COLORS.PRIMARY_RED,
    position: 'absolute',
    top: -1 * BASIC_SPACING,
    alignSelf: 'center',
    backgroundColor: COLORS.WHITE,
    fontSize: 12,
  },
  newMessagesTextDark: {
    backgroundColor: COLORS.DARKEST_BLUE,
  },
  resendButton: {
    backgroundColor: COLORS.LIGHT_GRAY,
    height: AVATAR_SIZE.small,
    borderRadius: AVATAR_SIZE.small / 2,
    paddingHorizontal: BASIC_SPACING * 2,
    marginLeft: BASIC_SPACING,
    alignItems: 'center',
    justifyContent: 'center',
  },
  resendText: {
    color: COLORS.PRIMARY_RED,
    fontSize: 12,
  },
})

const ConvoQuery = graphql(
  gql`
    ${MessageData}
    ${ProfileData}
    query ConversationQuery($id: ID!) {
      conversation(id: $id) {
        type
        subject
        messages {
          ...MessageData
        }
        peers {
          profile {
            ...ProfileData
          }
          state
        }
        pointer
        lastActiveTimestamp
        dark
      }

      viewer {
        profile {
          ...ProfileData
        }
      }
    }
  `,
  {
    options: props => ({
      fetchPolicy: 'network-only',
      variables: {
        id: props.id,
      },
    }),
    props: ({ data }) => ({
      data,
      subscribeToMessageAdded: (id: string) =>
        data.subscribeToMore({
          document: gql`
            ${MessageData}
            subscription MessageAddedSubscription($id: ID!) {
              messageAdded(id: $id) {
                conversation {
                  pointer
                  lastActiveTimestamp
                }
                message {
                  ...MessageData
                }
              }
            }
          `,
          variables: { id },
          updateQuery: (prev, { subscriptionData }) => ({
            conversation: {
              ...prev.conversation,
              ...subscriptionData.data.messageAdded.conversation,
              messages: [
                ...prev.conversation.messages,
                subscriptionData.data.messageAdded.message,
              ],
            },
            viewer: prev.viewer,
          }),
        }),
    }),
  },
)

// $FlowFixMe
export default compose(
  SetTypingMutation,
  SetTypingMutation,
  SendMessageMutation,
  UpdatePointerMutation,
  ResendInvitesMutation,
  ConvoQuery,
)(Conversation)
