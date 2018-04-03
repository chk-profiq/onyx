// @flow

import React, { Component } from 'react'

import Button from './Form/Button'
import Modal from './Modal'

type Props = {
    isOpen: boolean,
    onCloseModal: () => void,
    onPressRemove: () => void,
    profile: Object,
}

export default class RemoveModal extends Component<Props, State> {

    onCloseModal = () => {
        this.props.onCloseModal()
    }

    onPressRemove = () => {
        this.props.onPressRemove()
    }

    render() {
        const { isOpen, profile } = this.props
        let name = ''
        switch(profile.type){
            case 'channel' : name = profile.subject
                break
            case 'contact' : name = profile.name ? profile.name : 'this contact'
                break
            default: name = 'this'
        }
        return (
            <Modal
                isOpen={isOpen}
                onRequestClose={this.onCloseModal}
                title={"Are you sure to remove "+name}>
                <Button
                    onPress={this.onPressRemove}
                    title="Yes"
                />
                <Button
                    onPress={this.onCloseModal}
                    title="No"
                />
            </Modal>
        )
    }
}