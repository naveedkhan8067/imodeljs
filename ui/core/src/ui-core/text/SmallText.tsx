/*---------------------------------------------------------------------------------------------
* Copyright (c) 2019 Bentley Systems, Incorporated. All rights reserved.
* Licensed under the MIT License. See LICENSE.md in the project root for license terms.
*--------------------------------------------------------------------------------------------*/
/** @module Text */

import * as React from "react";
import * as classnames from "classnames";
import { TextProps } from "./TextProps";

/** Styled small text */

export class SmallText extends React.Component<TextProps> {
  public render(): JSX.Element {
    return (
      <span {...this.props} className={classnames("uicore-text-small", this.props.className)}>
        {this.props.children}
      </span>
    );
  }
}
export default SmallText;
