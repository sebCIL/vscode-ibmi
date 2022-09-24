const {default: IBMi} = require(`./IBMi`);

const path = require(`path`);
const util = require(`util`);
let fs = require(`fs`);
const tmp = require(`tmp`);
const csv = require(`csv/sync`);
const Tools = require(`./Tools`);

const tmpFile = util.promisify(tmp.file);
const readFileAsync = util.promisify(fs.readFile);
const writeFileAsync = util.promisify(fs.writeFile);

const UTF8_CCSIDS = [`819`, `1208`, `1252`];

module.exports = class IBMiContent {
  /**
   * @param {IBMi} instance 
   */
  constructor(instance) {
    this.ibmi = instance;
  }

  /**
   * @param {string} remotePath 
   * @param {string} localPath 
   */
  async downloadStreamfile(remotePath, localPath = null) {
    const features = this.ibmi.remoteFeatures;
    const config = this.ibmi.config;
    const client = this.ibmi.client;

    if (config.autoConvertIFSccsid && features.attr && features.iconv) {
      // If it's not 1208, generate a temp file with the converted content
      let ccsid = await this.ibmi.paseCommand(`${features.attr} "${remotePath}" CCSID`);
      if (typeof ccsid === `string`) {
        //What's the point of converting 1208?
        if (!UTF8_CCSIDS.includes(ccsid)) {
          ccsid = ccsid.padStart(3, `0`);
          const newTempFile = this.ibmi.getTempRemote(remotePath);
          await this.ibmi.paseCommand(`${features.iconv} -f IBM-${ccsid} -t UTF-8 "${remotePath}" > ${newTempFile}`);
          remotePath = newTempFile;
        }
      }
    }

    if (localPath == null) localPath = await tmpFile();
    await client.getFile(localPath, remotePath);
    return readFileAsync(localPath, `utf8`);
  }

  async writeStreamfile(originalPath, content) {
    const client = this.ibmi.client;
    const features = this.ibmi.remoteFeatures;
    const config = this.ibmi.config;

    let tmpobj = await tmpFile();

    let ccsid;

    if (config.autoConvertIFSccsid && features.attr && features.iconv) {
      // First, find the CCSID of the original file
      ccsid = await this.ibmi.paseCommand(`${features.attr} "${originalPath}" CCSID`);
      if (typeof ccsid === `string`) {
        if (UTF8_CCSIDS.includes(ccsid)) {
          ccsid = undefined; // Don't covert...
        } else {
          ccsid = ccsid.padStart(3, `0`);
        }
      }
    }

    await writeFileAsync(tmpobj, content, `utf8`);

    if (ccsid) {
      // Upload our file to the same temp file, then write convert it back to the original ccsid
      const tempFile = this.ibmi.getTempRemote(originalPath);
      await client.putFile(tmpobj, tempFile);
      return this.ibmi.paseCommand(`${features.iconv} -f UTF-8 -t IBM-${ccsid} "${tempFile}" > ${originalPath}`);

    } else {
      return client.putFile(tmpobj, originalPath);
    }
  }

  /**
   * Download the contents of a source member
   * @param {string|undefined} asp 
   * @param {string} lib 
   * @param {string} spf 
   * @param {string} mbr 
   */
  async downloadMemberContent(asp, lib, spf, mbr) {
    if (!asp) asp = this.ibmi.config.sourceASP;
    lib = lib.toUpperCase();
    spf = spf.toUpperCase();
    mbr = mbr.toUpperCase();

    const path = Tools.qualifyPath(asp, lib, spf, mbr);
    const tempRmt = this.ibmi.getTempRemote(path);
    const tmpobj = await tmpFile();
    const client = this.ibmi.client;

    let retried = false;
    let retry = 1;

    while (retry > 0) {
      retry--;
      try {
        //If this command fails we need to try again after we delete the temp remote
        await this.ibmi.remoteCommand(
          `CPYTOSTMF FROMMBR('${path}') TOSTMF('${tempRmt}') STMFOPT(*REPLACE) STMFCCSID(1208) DBFCCSID(${this.ibmi.config.sourceFileCCSID})`, `.`
        );
      } catch (e) {
        if (e.startsWith(`CPDA08A`)) {
          if (!retried) {
            await this.ibmi.paseCommand(`rm -f ` + tempRmt, `.`);
            retry++;
            retried = true;
          } else {
            throw e;
          }
        } else {
          throw e;
        }
      }
    }
    
    await client.getFile(tmpobj, tempRmt);
    let body = await readFileAsync(tmpobj, `utf8`);

    return body;
  }

  /**
   * Upload to a member
   * @param {string|undefined} asp 
   * @param {string} lib 
   * @param {string} spf 
   * @param {string} mbr 
   * @param {string|Uint8Array} content 
   */
  async uploadMemberContent(asp, lib, spf, mbr, content) {
    if (!asp) asp = this.ibmi.config.sourceASP;
    lib = lib.toUpperCase();
    spf = spf.toUpperCase();
    mbr = mbr.toUpperCase();

    const client = this.ibmi.client;
    const path = Tools.qualifyPath(asp, lib, spf, mbr);
    const tempRmt = this.ibmi.getTempRemote(path);
    const tmpobj = await tmpFile();

    try {
      await writeFileAsync(tmpobj, content, `utf8`);

      await client.putFile(tmpobj, tempRmt);
      await this.ibmi.remoteCommand(
        `QSYS/CPYFRMSTMF FROMSTMF('${tempRmt}') TOMBR('${path}') MBROPT(*REPLACE) STMFCCSID(1208) DBFCCSID(${this.ibmi.config.sourceFileCCSID})`,
      );

      return true;
    } catch (error) {
      console.log(`Failed uploading member: ` + error);
      return Promise.reject(error);
    }
  }
  
  /**
   * Run an SQL statement
   * @param {string} statement
   * @returns {Promise<any[]>} Result set
   */
  async runSQL(statement) {
    const { 'QZDFMDB2.PGM': QZDFMDB2 } = this.ibmi.remoteFeatures;

    if (QZDFMDB2) {
      // Well, the fun part about db2 is that it always writes to standard out.
      // It does not write to standard error at all.

      // We join all new lines together
      //statement = statement.replace(/\n/g, ` `);

      const output = await this.ibmi.sendCommand({
        command: `LC_ALL=EN_US.UTF-8 system "call QSYS/QZDFMDB2 PARM('-d' '-i' '-t')"`,
        stdin: statement,
      })

      if (output.stdout) {
        return Tools.db2Parse(output.stdout);
      } else {
        throw new Error(`There was an error running the SQL statement.`);
      }

    } else {
      throw new Error(`There is no way to run SQL on this system.`);
    }
  }

  /**
   * Download the contents of a table.
   * @param {string} lib 
   * @param {string} file 
   * @param {string} [mbr] Will default to file provided 
   * @param {boolean} [deleteTable] Will delete the table after download
   */
  async getTable(lib, file, mbr, deleteTable) {
    if (!mbr) mbr = file; //Incase mbr is the same file

    if (file === mbr && this.ibmi.config.enableSQL) {
      const data = await this.runSQL(`SELECT * FROM ${lib}.${file}`);
      
      if (deleteTable && this.ibmi.config.autoClearTempData) {
        this.ibmi.remoteCommand(`DLTOBJ OBJ(${lib}/${file}) OBJTYPE(*FILE)`, `.`);
      }

      return data;

    } else {
      const tempRmt = this.ibmi.getTempRemote(Tools.qualifyPath(undefined, lib, file, mbr));

      await this.ibmi.remoteCommand(
        `QSYS/CPYTOIMPF FROMFILE(` +
          lib +
          `/` +
          file +
          ` ` +
          mbr +
          `) ` +
          `TOSTMF('` +
          tempRmt +
          `') MBROPT(*REPLACE) STMFCCSID(1208) RCDDLM(*CRLF) DTAFMT(*DLM) RMVBLANK(*TRAILING) ADDCOLNAM(*SQL) FLDDLM(',') DECPNT(*PERIOD) `,
      );

      let result = await this.downloadStreamfile(tempRmt);

      if (this.ibmi.config.autoClearTempData) {
        this.ibmi.paseCommand(`rm -f ` + tempRmt, `.`);
        if (deleteTable)
          this.ibmi.remoteCommand(`DLTOBJ OBJ(${lib}/${file}) OBJTYPE(*FILE)`, `.`);
      }

      return csv.parse(result, {
        columns: true,
        skip_empty_lines: true,
      });
    }
    
  }

  /**
   * Get list of libraries with description and attribute
   * @param {string[]} libraries Array of libraries to retrieve
   * @returns {Promise<{name: string, text: string, attribute: string}[]>} List of libraries
   */
  async getLibraryList(libraries) {
    const config = this.ibmi.config;
    const tempLib = this.ibmi.config.tempLibrary;
    const TempName = Tools.makeid();
    let results;

    if (config.enableSQL) {
      const statement = `
        select os.OBJNAME as ODOBNM
             , coalesce(os.OBJTEXT, '') as ODOBTX
             , os.OBJATTRIBUTE as ODOBAT
          from table( SYSTOOLS.SPLIT( INPUT_LIST => '${libraries.toString()}', DELIMITER => ',' ) ) libs
             , table( QSYS2.OBJECT_STATISTICS( OBJECT_SCHEMA => 'QSYS', OBJTYPELIST => '*LIB', OBJECT_NAME => libs.ELEMENT ) ) os
      `;
      results = await this.runSQL(statement);
    } else {
      await this.ibmi.remoteCommand(`DSPOBJD OBJ(QSYS/*ALL) OBJTYPE(*LIB) DETAIL(*TEXTATR) OUTPUT(*OUTFILE) OUTFILE(${tempLib}/${TempName})`);
      results = await this.getTable(tempLib, TempName, TempName, true);

      if (results.length === 1) {
        if (results[0].ODOBNM.trim() === ``) {
          return []
        }
      };

      results = results.filter(object => (libraries.includes(this.ibmi.sysNameInLocal(object.ODOBNM))));
    };

    results = results.map(object => ({
      name: config.enableSQL ? object.ODOBNM : this.ibmi.sysNameInLocal(object.ODOBNM),
      attribute: object.ODOBAT,
      text: object.ODOBTX
    }));

    return libraries.map(lib => {
      const index = results.findIndex(info => info.name === lib);
      if (index >= 0) {
        return results[index];
      } else {
        return {
          name: lib,
          attribute: ``,
          text: `*** NOT FOUND ***`
        };
      }
    });
  }

  /**
   * @param {{library: string, object?: string, types?: string[]}} filters 
   * @returns {Promise<{library: string, name: string, type: string, text: string, attribute: string, count?: number}[]>} List of members 
   */
  async getObjectList(filters) {
    const library = filters.library.toUpperCase();
    const object = (filters.object && filters.object !== `*` ? filters.object.toUpperCase() : `*ALL`);
    const sourceFilesOnly = (filters.types && filters.types.includes(`*SRCPF`));

    const tempLib = this.ibmi.config.tempLibrary;
    const TempName = Tools.makeid();

    if (sourceFilesOnly) {
      await this.ibmi.remoteCommand(`DSPFD FILE(${library}/${object}) TYPE(*ATR) FILEATR(*PF) OUTPUT(*OUTFILE) OUTFILE(${tempLib}/${TempName})`);

      const results = await this.getTable(tempLib, TempName, TempName, true);
      if (results.length === 1) {
        if (results[0].PHFILE.trim() === ``) {
          return []
        }
      }

      return results
        .filter(object => object.PHDTAT === `S`)
        .map(object => ({
          library,
          name: this.ibmi.sysNameInLocal(object.PHFILE),
          type: `*FILE`,
          attribute: object.PHFILA,
          text: object.PHTXT,
          count: object.PHNOMB,
        }))
        .sort((a, b) => {
          if (a.library.localeCompare(b.library) != 0) return a.library.localeCompare(b.library)
          else return a.name.localeCompare(b.name);
        });

    } else {
      const objectTypes = (filters.types && filters.types.length > 0 ? filters.types.map(type => type.toUpperCase()).join(` `) : `*ALL`);

      await this.ibmi.remoteCommand(`DSPOBJD OBJ(${library}/${object}) OBJTYPE(${objectTypes}) OUTPUT(*OUTFILE) OUTFILE(${tempLib}/${TempName})`);
      const results = await this.getTable(tempLib, TempName, TempName, true);

      if (results.length === 1) {
        if (results[0].ODOBNM.trim() === ``) {
          return []
        }
      }

      return results
        .map(object => ({
          library,
          name: this.ibmi.sysNameInLocal(object.ODOBNM),
          type: object.ODOBTP,
          attribute: object.ODOBAT,
          text: object.ODOBTX
        }))
        .sort((a, b) => {
          if (a.library.localeCompare(b.library) != 0) return a.library.localeCompare(b.library)
          else return a.name.localeCompare(b.name);
        });
    }
  }

  /**
   * @param {string} lib 
   * @param {string} spf
   * @param {string} [mbr]
   * @returns {Promise<{asp?: string, library: string, file: string, name: string, extension: string, recordLength: number, text: string}[]>} List of members 
   */
  async getMemberList(lib, spf, mbr = `*`, ext = `*`) {
    const config = this.ibmi.config;
    const library = lib.toUpperCase();
    const sourceFile = spf.toUpperCase();
    let member = (mbr !== `*` ? mbr : null);
    let memberExt = (ext !== `*` ? ext : null);

    let results;

    if (config.enableSQL) {
      if (member) member = member.replace(/[*]/g, `%`);
      if (memberExt) memberExt = memberExt.replace(/[*]/g, `%`);

      const statement = `
        SELECT
          (b.avgrowsize - 12) as MBMXRL,
          a.iasp_number as MBASP,
          cast(a.system_table_name as char(10) for bit data) AS MBFILE,
          cast(b.system_table_member as char(10) for bit data) as MBNAME,
          coalesce(cast(b.source_type as varchar(10) for bit data), '') as MBSEU2,
          coalesce(b.partition_text, '') as MBMTXT
        FROM qsys2.systables AS a
          JOIN qsys2.syspartitionstat AS b
            ON b.table_schema = a.table_schema AND
              b.table_name = a.table_name
        WHERE
          cast(a.system_table_schema as char(10) for bit data) = '${library}' 
          ${sourceFile !== `*ALL` ? `AND cast(a.system_table_name as char(10) for bit data) = '${sourceFile}'` : ``}
          ${member ? `AND rtrim(cast(b.system_table_member as char(10) for bit data)) like '${member}'` : ``}
          ${memberExt ? `AND rtrim(coalesce(cast(b.source_type as varchar(10) for bit data), '')) like '${memberExt}'` : ``}
      `;
      results = await this.runSQL(statement);

    } else {
      const tempLib = config.tempLibrary;
      const TempName = Tools.makeid();

      await this.ibmi.remoteCommand(`DSPFD FILE(${library}/${sourceFile}) TYPE(*MBR) OUTPUT(*OUTFILE) OUTFILE(${tempLib}/${TempName})`);
      results = await this.getTable(tempLib, TempName, TempName, true);

      if (results.length === 1) {
        if (results[0].MBNAME.trim() === ``) {
          return []
        }
      }

      if (member || memberExt) {
        let pattern, patternExt;
        if (member) pattern = new RegExp(`^` + member.replace(/[*]/g, `.*`).replace(/[$]/g, `\\$`) + `$`);
        if (memberExt) patternExt = new RegExp(`^` + memberExt.replace(/[*]/g, `.*`).replace(/[$]/g, `\\$`) + `$`);
        results = results.filter(row => ((pattern === undefined || pattern.test(row.MBNAME)) && (patternExt === undefined || patternExt.test(row.MBSEU2))));
      }
    }
    
    if (results.length === 0) return [];

    results = results.sort((a, b) => {
      return a.MBNAME.localeCompare(b.MBNAME);
    });

    const asp = this.ibmi.aspInfo[Number(results[0].MBASP)];

    return results.map(result => ({
      asp: asp,
      library: library,
      file: result.MBFILE,
      name: result.MBNAME,
      extension: result.MBSEU2,
      recordLength: Number(result.MBMXRL),
      text: `${result.MBMTXT || ``}${sourceFile === `*ALL` ? ` (${result.MBFILE})` : ``}`.trim()
    }));
  }

  /**
   * Get list of items in a path
   * @param {string} remotePath 
   * @return {Promise<{type: "directory"|"streamfile", name: string, path: string}[]>} Resulting list
   */
  async getFileList(remotePath) {
    const result = await this.ibmi.sendCommand({
      command: `ls -a -p -L ${Tools.escapePath(remotePath)}`
    });

    //@ts-ignore
    const fileList = result.stdout;

    if (fileList !== ``) {
      let list = fileList.split(`\n`);

      //Remove current and dir up.
      list = list.filter(item => item !== `../` && item !== `./`);

      const items = list.map(item => {
        const type = (item.endsWith(`/`) ? `directory` : `streamfile`);

        return {
          type, 
          name: (type === `directory` ? item.substring(0, item.length - 1) : item),
          path: path.posix.join(remotePath, item)
        };
      });

      //@ts-ignore because it thinks "dictionary"|"streamfile" is a string from the sort call.
      return items.sort((a, b) => {
        if (a.name < b.name) { return -1; }
        if (a.name > b.name) { return 1; }
        return 0;
      });
    } else {
      return [];
    }
  }

  /**
   * @param {string} errorsString 
   * @returns {{code: string, text: string}[]} errors
   */
  parseIBMiErrors(errorsString) {
    let errors = [];

    let code, text;
    for (const error of errorsString.split(`\n`)) {
      [code, text] = error.split(`:`);
      errors.push({code, text});
    }

    return errors;
  }

  /**
   * 
   * @param {string} lib 
   * @param {string} objName 
   * @param {string} objType 
   * @param {string} objSubType 
   * @returns 
   */
  async getObjectProperties(lib, objName, objType, objSubType){

    const config = this.ibmi.config;
    const library = lib.toUpperCase();
    const name = objName.toUpperCase();
    const type = objType.toUpperCase();
    const subType = objSubType.toUpperCase();
    
    let objectProperties = [];
    let results;

    switch (type) {
    case `SRVPGM`:
    case `PGM`:
      if (config.enableSQL){
        objectProperties = await this.runSQL([`SELECT q.propertie, q.value
        FROM QSYS2.PROGRAM_INFO a,
        table (values
        ('Name', a.PROGRAM_NAME),
        ('Attribute', a.PROGRAM_ATTRIBUTE),
        ('Object type', a.OBJECT_TYPE),
        ('Type', a.PROGRAM_TYPE),
        ('Text', a.TEXT_DESCRIPTION),
        ('Size', trim(TO_CHAR(a.OPM_PROGRAM_SIZE,'999G999G999G999'))),
        ('Owner', a.PROGRAM_OWNER),
        ('Created', varchar_format(a.CREATE_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS')),
        ('Source file member', a.SOURCE_FILE_MEMBER),
        ('Source file', a.SOURCE_FILE),
        ('Source file library', a.SOURCE_FILE_LIBRARY)
        ) AS Q(propertie, value)
          WHERE A.PROGRAM_LIBRARY = '${library}'
                AND A.PROGRAM_NAME = '${name}'
                AND A.OBJECT_TYPE = '*${type}'`].join(` `));
                
      } else {

        const tempLib = config.tempLibrary;
        const tempName = Tools.makeid();

        await this.ibmi.remoteCommand(`DSPOBJD OBJ(${library}/${name}) OBJTYPE(*${type}) DETAIL(*FULL) OUTPUT(*OUTFILE) OUTFILE(${tempLib}/${tempName})`);
        results = await this.getTable(tempLib, tempName, tempName, true);

        if (results.length === 1) {
          if (results[0].ODOBNM.trim() === ``) {
            return []
          }
        }

        let resultsObject = results[0];
        let i=0;
        let dateCentury = 0;

        Object.keys(resultsObject).forEach(key => {
          const valeur = resultsObject[key];
          switch (key) {
          case `ODDCEN`:
            dateCentury = valeur;
            break;
          case `ODOBNM`:
            objectProperties[i] = {PROPERTIE: `Name`, VALUE: valeur};
            break;
          case `ODOBAT`:
            objectProperties[i] = {PROPERTIE: `Attribute`, VALUE: valeur};
            break;
          case `ODOBTP`:
            objectProperties[i] = {PROPERTIE: `Object type`, VALUE: valeur};
            break;
          case `ODOBTX`:
            objectProperties[i] = {PROPERTIE: `Text`, VALUE: valeur};
            break;
          case `ODOBSZ`:
            objectProperties[i] = {PROPERTIE: `Size`, VALUE: valeur};
            break;
          case `ODOBOW`:
            objectProperties[i] = {PROPERTIE: `Owner`, VALUE: valeur};
            break;
          case `ODCDAT`:
            const dateCreated = this.ibmi.dateMMDDYYToDate(dateCentury, valeur);
            objectProperties[i] = {PROPERTIE: `Created`, VALUE: dateCreated.toString()};
            break;
          case `ODSRCM`:
            objectProperties[i] = {PROPERTIE: `Source file member`, VALUE: valeur};
            break;
          case `ODSRCF`:
            objectProperties[i] = {PROPERTIE: `Source file`, VALUE: valeur};
            break;
          case `ODSRCL`:
            objectProperties[i] = {PROPERTIE: `Source file library`, VALUE: valeur};
            break;
        
          default:
            break;
          }

          i++;
        });
      }

      break;

    case `BNDDIR`:
      if (config.enableSQL){
        objectProperties =  await this.runSQL([`SELECT q.propertie, q.value
        FROM TABLE ( QSYS2.OBJECT_STATISTICS('${library}', '*ALL', OBJECT_NAME => '${name}') ) A,
        table (values
        ('Long name', A.OBJLONGNAME),
        ('Long schema', A.OBJLONGSCHEMA),
        ('Object type', A.OBJTYPE),
        ('Attribute', A.OBJATTRIBUTE),
        ('Text', ifnull(A.OBJTEXT, '')),
        ('Size', trim(TO_CHAR(A.OBJSIZE,'999G999G999G999'))),
        ('iASP number', trim(TO_CHAR(A.IASP_NUMBER,'99999'))),
        ('iASP name', A.IASP_NAME),
        ('Save timestamp', ifnull(varchar_format(A.SAVE_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS'), '')),
        ('Restore timestamp', ifnull(varchar_format(A.RESTORE_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS'), '')),
        ('Save command', A.SAVE_COMMAND),
        ('Save device', A.SAVE_DEVICE),
        ('Save volume', A.SAVE_VOLUME),
        ('Save label', A.SAVE_LABEL),
        ('Save file name', ifnull(A.SAVE_FILE_NAME, '')),
        ('Save file library', ifnull(A.SAVE_FILE_LIBRARY, '')),
        ('Object owner', A.OBJOWNER),
        ('Object audit', A.OBJECT_AUDIT),
        ('Created', ifnull(varchar_format(A.OBJCREATED, 'YYYY-MM-DD HH24:MI:SS'), '')),
        ('Definer', A.OBJDEFINER),
        ('Created system', A.CREATED_SYSTEM),
        ('Created system version', A.CREATED_SYSTEM_VERSION),
        ('Domain', A.OBJECT_DOMAIN),
        ('Change timestamp', ifnull(varchar_format(A.CHANGE_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS'), '')),
        ('Last used timestamp', ifnull(varchar_format(A.LAST_USED_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS'), '')),
        ('Days used count', trim(TO_CHAR(A.DAYS_USED_COUNT,'999999'))),
        ('Last reset timestamp', ifnull(varchar_format(A.LAST_RESET_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS'), '')),
        ('Source member', ifnull(A.SOURCE_MEMBER, '')),
        ('Source library', ifnull(A.SOURCE_LIBRARY, '')),
        ('Source file', ifnull(A.SOURCE_FILE, '')),
        ('Source timestamp', ifnull(varchar_format(A.SOURCE_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS'), '')),
        ('Journaled', A.JOURNALED),
        ('Journal name', ifnull(A.JOURNAL_NAME, '')),
        ('Journal library', ifnull(A.JOURNAL_LIBRARY, '')),
        ('Journal images', ifnull(A.JOURNAL_IMAGES, ''))
        ) AS Q(propertie, value)`].join(` `));
        break;

      }
      break;

    case `FILE`:
      if (config.enableSQL){
        objectProperties =  await this.runSQL([`SELECT q.propertie, q.value
        FROM TABLE ( QSYS2.OBJECT_STATISTICS('${library}', '*ALL', OBJECT_NAME => '${name}') ) A,
        table (values
        ('Long name', A.OBJLONGNAME),
        ('Long schema', A.OBJLONGSCHEMA),
        ('Object type', A.OBJTYPE),
        ('Attribute', A.OBJATTRIBUTE),
        ('Text', ifnull(A.OBJTEXT, '')),
        ('Size', trim(TO_CHAR(A.OBJSIZE,'999G999G999G999'))),
        ('iASP number', trim(TO_CHAR(A.IASP_NUMBER,'99999'))),
        ('iASP name', A.IASP_NAME),
        ('Save timestamp', ifnull(varchar_format(A.SAVE_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS'), '')),
        ('Restore timestamp', ifnull(varchar_format(A.RESTORE_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS'), '')),
        ('Save command', A.SAVE_COMMAND),
        ('Save device', A.SAVE_DEVICE),
        ('Save volume', A.SAVE_VOLUME),
        ('Save label', A.SAVE_LABEL),
        ('Save file name', ifnull(A.SAVE_FILE_NAME, '')),
        ('Save file library', ifnull(A.SAVE_FILE_LIBRARY, '')),
        ('Object owner', A.OBJOWNER),
        ('Object audit', A.OBJECT_AUDIT),
        ('Created', ifnull(varchar_format(A.OBJCREATED, 'YYYY-MM-DD HH24:MI:SS'), '')),
        ('Definer', A.OBJDEFINER),
        ('Created system', A.CREATED_SYSTEM),
        ('Created system version', A.CREATED_SYSTEM_VERSION),
        ('Domain', A.OBJECT_DOMAIN),
        ('Change timestamp', ifnull(varchar_format(A.CHANGE_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS'), '')),
        ('Last used timestamp', ifnull(varchar_format(A.LAST_USED_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS'), '')),
        ('Days used count', trim(TO_CHAR(A.DAYS_USED_COUNT,'999999'))),
        ('Last reset timestamp', ifnull(varchar_format(A.LAST_RESET_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS'), '')),
        ('Source member', ifnull(A.SOURCE_MEMBER, '')),
        ('Source library', ifnull(A.SOURCE_LIBRARY, '')),
        ('Source file', ifnull(A.SOURCE_FILE, '')),
        ('Source timestamp', ifnull(varchar_format(A.SOURCE_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS'), '')),
        ('Journaled', A.JOURNALED),
        ('Journal name', ifnull(A.JOURNAL_NAME, '')),
        ('Journal library', ifnull(A.JOURNAL_LIBRARY, '')),
        ('Journal images', ifnull(A.JOURNAL_IMAGES, ''))
        ) AS Q(propertie, value)`].join(` `));
        break;

      } else {

        const tempLib = config.tempLibrary;
        const tempName = Tools.makeid();

        await this.ibmi.remoteCommand(`DSPFD FILE(${library}/${name}) TYPE(*ATR) OUTPUT(*OUTFILE) FILEATR(*${subType}) OUTFILE(${tempLib}/${tempName})`);
        results = await this.getTable(tempLib, tempName, tempName, true);

        if (results.length === 1) {
          switch (subType) {
          case `PF`:
            if (results[0].PHFILE.trim() === ``) {
              return []
            }            
            break;

          case `LF`:
            if (results[0].LGFILE.trim() === ``) {
              return []
            }            
            break;
        
          default:
            return []
          }
          
        }

        let resultsObject = results[0];
        let i=0;
        let dateCentury = 0;

        switch (subType) {
        case `PF`:
          
          Object.keys(resultsObject).forEach(key => {
            const valeur = resultsObject[key];
            switch (key) {
            case `PHFCCN`:
              dateCentury = valeur;
              break;
            case `PHLNTB`:
              objectProperties[i] = {PROPERTIE: `Long name`, VALUE: valeur};
              break;
            case `PHFILE`:
              objectProperties[i] = {PROPERTIE: `Short name`, VALUE: valeur};
              break;
            case `PHLIB`:
              objectProperties[i] = {PROPERTIE: `Schema`, VALUE: valeur};
              break;
            case `PHFILA`:
              objectProperties[i] = {PROPERTIE: `Object type`, VALUE: valeur};
              break;
            case `PHFATR`:
              objectProperties[i] = {PROPERTIE: `Attribute`, VALUE: valeur};
              break;
            case `PHTXT`:
              objectProperties[i] = {PROPERTIE: `Text`, VALUE: valeur};
              break;
            case `PHASP`:
              objectProperties[i] = {PROPERTIE: `iASP number`, VALUE: valeur};
              break;
            case `PHFCDT`:
              const dateCreated = this.ibmi.dateYYMMDDToDate(dateCentury, valeur);
              objectProperties[i] = {PROPERTIE: `Created`, VALUE: dateCreated.toString()};
              break;
            case `PHJRNL`:
              objectProperties[i] = {PROPERTIE: `Journaled`, VALUE: valeur};
              break;
            case `PHJRNM`:
              objectProperties[i] = {PROPERTIE: `Journal name`, VALUE: valeur};
              break;
            case `PHJRLB`:
              objectProperties[i] = {PROPERTIE: `Journal library`, VALUE: valeur};
              break;
            case `PHJRIM`:
              objectProperties[i] = {PROPERTIE: `Journal images`, VALUE: valeur};
              break;
          
            default:
              break;
            }

            i++;
          });
          break;

        case `LF`:
          
          Object.keys(resultsObject).forEach(key => {
            const valeur = resultsObject[key];
            switch (key) {
            case `LGFCCN`:
              dateCentury = valeur;
              break;
            case `LGLNTB`:
              objectProperties[i] = {PROPERTIE: `Long name`, VALUE: valeur};
              break;
            case `LGFILE`:
              objectProperties[i] = {PROPERTIE: `Short name`, VALUE: valeur};
              break;
            case `LGLIB`:
              objectProperties[i] = {PROPERTIE: `Schema`, VALUE: valeur};
              break;
            case `LGFILA`:
              objectProperties[i] = {PROPERTIE: `Object type`, VALUE: valeur};
              break;
            case `LGFATR`:
              objectProperties[i] = {PROPERTIE: `Attribute`, VALUE: valeur};
              break;
            case `LGTXT`:
              objectProperties[i] = {PROPERTIE: `Text`, VALUE: valeur};
              break;
            case `LGASP`:
              objectProperties[i] = {PROPERTIE: `iASP number`, VALUE: valeur};
              break;
            case `LGFCDT`:
              const dateCreated = this.ibmi.dateYYMMDDToDate(dateCentury, valeur);
              objectProperties[i] = {PROPERTIE: `Created`, VALUE: dateCreated.toString()};
              break;
            case `LGNOFM`:
              objectProperties[i] = {PROPERTIE: `Number of record formats`, VALUE: valeur};
              break;
            case `LGFLS`:
              objectProperties[i] = {PROPERTIE: `Externally described`, VALUE: valeur};
              break;
            case `LGSELO`:
              objectProperties[i] = {PROPERTIE: `Select/Omit`, VALUE: valeur};
              break;
          
            default:
              break;
            }

            i++;
          });
                     
          break;
        }
      }

    case `DTAARA`:
      if (config.enableSQL){
        objectProperties =  await this.runSQL([`SELECT q.propertie, q.value
        FROM TABLE ( QSYS2.OBJECT_STATISTICS('${library}', '*ALL', OBJECT_NAME => '${name}') ) A,
        table (values
        ('Long name', A.OBJLONGNAME),
        ('Long schema', A.OBJLONGSCHEMA),
        ('Object type', A.OBJTYPE),
        ('Attribute', A.OBJATTRIBUTE),
        ('Text', ifnull(A.OBJTEXT, '')),
        ('Size', trim(TO_CHAR(A.OBJSIZE,'999G999G999G999'))),
        ('iASP number', trim(TO_CHAR(A.IASP_NUMBER,'99999'))),
        ('iASP name', A.IASP_NAME),
        ('Save timestamp', ifnull(varchar_format(A.SAVE_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS'), '')),
        ('Restore timestamp', ifnull(varchar_format(A.RESTORE_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS'), '')),
        ('Save command', A.SAVE_COMMAND),
        ('Save device', A.SAVE_DEVICE),
        ('Save volume', A.SAVE_VOLUME),
        ('Save label', A.SAVE_LABEL),
        ('Save file name', ifnull(A.SAVE_FILE_NAME, '')),
        ('Save file library', ifnull(A.SAVE_FILE_LIBRARY, '')),
        ('Object owner', A.OBJOWNER),
        ('Object audit', A.OBJECT_AUDIT),
        ('Created', ifnull(varchar_format(A.OBJCREATED, 'YYYY-MM-DD HH24:MI:SS'), '')),
        ('Definer', A.OBJDEFINER),
        ('Created system', A.CREATED_SYSTEM),
        ('Created system version', A.CREATED_SYSTEM_VERSION),
        ('Domain', A.OBJECT_DOMAIN),
        ('Change timestamp', ifnull(varchar_format(A.CHANGE_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS'), '')),
        ('Last used timestamp', ifnull(varchar_format(A.LAST_USED_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS'), '')),
        ('Days used count', trim(TO_CHAR(A.DAYS_USED_COUNT,'999999'))),
        ('Last reset timestamp', ifnull(varchar_format(A.LAST_RESET_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS'), '')),
        ('Source member', ifnull(A.SOURCE_MEMBER, '')),
        ('Source library', ifnull(A.SOURCE_LIBRARY, '')),
        ('Source file', ifnull(A.SOURCE_FILE, '')),
        ('Source timestamp', ifnull(varchar_format(A.SOURCE_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS'), '')),
        ('Journaled', A.JOURNALED),
        ('Journal name', ifnull(A.JOURNAL_NAME, '')),
        ('Journal library', ifnull(A.JOURNAL_LIBRARY, '')),
        ('Journal images', ifnull(A.JOURNAL_IMAGES, ''))
        ) AS Q(propertie, value)
        union all
        SELECT q.propertie, q.value
        FROM TABLE ( QSYS2.DATA_AREA_INFO( DATA_AREA_NAME => 'BILNUM', DATA_AREA_LIBRARY => 'DENITRAL') ) A,
        TABLE (VALUES('Data area type',A.DATA_AREA_TYPE),
            ('Length',trim(TO_CHAR(A.LENGTH,'999999999999'))),
            ('Decimal positions', trim(TO_CHAR(A.LENGTH,'999999999999'))),
            ('Value', A.DATA_AREA_VALUE)
        ) AS Q (propertie, value)`].join(` `));
        break;

      }

      break;

    default:
      break;
    }

    return objectProperties;
  }

  
  /**
   * 
   * @param {string} libraryMember 
   * @param {string} fileMember 
   * @param {string} memberName 
   * @returns 
   */
  async getMemberProperties(libraryMember, fileMember, memberName){

    const config = this.ibmi.config;
    const library = libraryMember.toUpperCase();
    const file = fileMember.toUpperCase();
    const member = memberName.toUpperCase();
    
    let memberProperties = [];

    if (config.enableSQL){
      memberProperties = await this.runSQL([`SELECT q.propertie, q.value
      FROM QSYS2.SYSPARTITIONSTAT a,
      table (values
        ('Member', a.SYSTEM_TABLE_MEMBER),
        ('File', a.SYSTEM_TABLE_NAME),
        ('Library', a.SYSTEM_TABLE_SCHEMA),
        ('Type', a.SOURCE_TYPE),
        ('Member text', a.PARTITION_TEXT),
        ('Created', varchar_format(a.CREATE_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS')),
        ('Last updated', ifnull(varchar_format(a.LAST_SOURCE_UPDATE_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS'), '')),
        ('Change timestamp', ifnull(varchar_format(a.LAST_CHANGE_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS'), '')),
        ('Save timestamp', ifnull(varchar_format(a.LAST_SAVE_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS'), '')),
        ('Restore timestamp', ifnull(varchar_format(a.LAST_RESTORE_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS'), '')),
        ('Records', trim(TO_CHAR(a.NUMBER_ROWS,'999G999G999G999'))),
        ('Deleted records', trim(TO_CHAR(a.NUMBER_DELETED_ROWS, '999G999G999G999'))),
        ('Size', trim(TO_CHAR(a.DATA_SIZE,'999G999G999G999'))))
            AS Q(propertie, value)
          WHERE a.SYSTEM_TABLE_SCHEMA = '${library}'
            AND a.SYSTEM_TABLE_NAME = '${file}'
            AND a.SOURCE_TYPE IS NOT NULL 
            AND a.SYSTEM_TABLE_MEMBER = '${member}'`].join(` `));
              
    } else {

    }

    return memberProperties;
  }
}
