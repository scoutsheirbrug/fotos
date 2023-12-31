import { Component } from 'preact'
import { route } from 'preact-router'

export default class Redirect extends Component<{ to: string }> {
  componentWillMount() {
    route(this.props.to, true);
  }

  render() {
    return null;
  }
}
