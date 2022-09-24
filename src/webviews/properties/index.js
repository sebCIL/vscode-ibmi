const vscode = require(`vscode`);

module.exports = class propertiesUI {

  /**
   * @param {{propertie: string, value: string}[]} properties
   */
  static async init(properties) {

    const panel = vscode.window.createWebviewPanel(
      `custom`,
      `Properties`,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true
      }
    );

    panel.webview.html = getWebviewContent(properties);

  }
  
}

function getWebviewContent(properties) {
  return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Job log</title>
        <style type="text/css">
        .divTable {
          display: table;
          width: 100%;
        }
    
        .divTableRow {
          display: table-row;
        }
    
        .divTableCell {
          border: 0px;
          display: table-cell;
          padding: 3px 10px;
        }

        .divTableHead {
          display: table-cell;
          padding: 3px 10px;
        }
    
        .divTableHeading {
          display: table-header-group;
          font-weight: bold;
        }
        
        .divTableBody {
          display: table-row-group;
        }
      </style>
    </head>
    <body>
    <div class="divTable">
      <div class="divTableHeading">
        <div class="divTableHead">
          Propertie
        </div>
        <div class="divTableHead">
          Value
        </div>
      </div>
      <div class="divTableBody">
        ${properties.map(propertie => {return `<div class="divTableRow">
        <div class="divTableCell">${propertie.PROPERTIE}</div>
        <div class="divTableCell">${propertie.VALUE}</div>
        </div>`}).join(``)}
      </div>
    </div>
    </body>
    </html>`;
}