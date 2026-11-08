import React from 'react';
import { ExternalLink, Scale, X } from 'lucide-react';

interface LicensesModalProps {
  open: boolean;
  onClose: () => void;
}

export const LicensesModal: React.FC<LicensesModalProps> = ({ open, onClose }) => {
  if (!open) return null;

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="licenses-modal-title"
    >
      <div className="modal-card licenses-modal">
        <div className="modal-header">
          <div className="panel-title-row">
            <Scale size={18} className="accent-icon" aria-hidden="true" />
            <h3 id="licenses-modal-title">Open-Source Software Notices</h3>
          </div>
          <button
            type="button"
            className="btn-icon"
            aria-label="Close open-source licences modal"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        <div className="licenses-content">
          <section className="license-block">
            <h4>TradingView Lightweight Charts&trade; (v5.2.1) &mdash; Apache-2.0</h4>
            <p>
              Charts in this application are powered by{' '}
              <a
                href="https://www.tradingview.com/lightweight-charts/"
                target="_blank"
                rel="noopener noreferrer"
              >
                TradingView Lightweight Charts&trade; <ExternalLink size={12} />
              </a>{' '}
              from{' '}
              <a
                href="https://www.tradingview.com/"
                target="_blank"
                rel="noopener noreferrer"
              >
                TradingView, Inc. <ExternalLink size={12} />
              </a>
            </p>
            <pre className="license-pre">
{`Copyright 2023 TradingView, Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.`}
            </pre>
          </section>

          <section className="license-block">
            <h4>React &amp; React DOM (v19) &mdash; MIT License</h4>
            <p className="muted-note">Copyright (c) Meta Platforms, Inc. and affiliates.</p>
          </section>

          <section className="license-block">
            <h4>Express &amp; Cookie-Parser &mdash; MIT License</h4>
            <p className="muted-note">Copyright (c) OpenJS Foundation and contributors.</p>
          </section>

          <section className="license-block">
            <h4>Lucide Icons (lucide-react) &mdash; ISC License</h4>
            <p className="muted-note">Copyright (c) Lucide Contributors.</p>
          </section>
        </div>

        <div className="modal-actions">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
