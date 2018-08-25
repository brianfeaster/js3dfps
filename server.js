#!/usr/bin/node
"use strict";


////////////////////////////////////////////////////////////////////////////////
// Aliases
////////////////////////////////////////////////////////////////////////////////
const Util=require('util');
const Crypto=require('crypto');
const Log = console.log;


////////////////////////////////////////////////////////////////////////////////
// Debuggin
////////////////////////////////////////////////////////////////////////////////

const DB = (function () {
  var log = function (h, o) {
    switch (arguments.length) {
     case 1:
       Log(h);
       break;
     case 2:
       Log("\x1b[35m==" + h + "=".repeat(70) + "\x1b[0m")
       Log(o);
       Log();
       //console.log("\033[35m--" + h + "-".repeat(70) + "\033[0m\n")
    };
  };
  var self = log;
  self.log = log;
  return self;
})();


////////////////////////////////////////////////////////////////////////////////
// Server
////////////////////////////////////////////////////////////////////////////////
const Net=require('net');
const qserver = Net.createServer(receiveConnection);
qserver.listen(7199);


////////////////////////////////////////////////////////////////////////////////
// Listener
////////////////////////////////////////////////////////////////////////////////
let connectionCount= 0;

function receiveConnection (s) { // socket
  var count = ++connectionCount;
  s.on('data', receiveBuffer.bind(null,count,s));
};



////////////////////////////////////////////////////////////////////////////////
// Agent
////////////////////////////////////////////////////////////////////////////////
var buffers = new Buffer(0);
var httpHeaders = {};

function receiveBuffer (id, s, b) { // number socket Buffer
  //DB("\x1b[33m" + JSON.stringify(b.toString()) + "\x1b[0m");
  buffers = Buffer.concat([buffers,b]);
  //DB(buffers)
  consume(id, s)
}

var yeld = false; // When true, the state machine loop shoudl return until called with more buffer.
var state = 0;

function consume (id, s) { // id socket
  var statein = state, msg;
  //DB("\x1b[33mconsume " + id + " " + state + "\x1b[0m");
  while (!yeld) {
    //DB("\x1b[1;30m[SM " + state + "]\x1b[0m");
    switch (state) {
    case 0: // READ HEADERS AND UPDATE WEBSOCKET PROTOCOL
      consumeHttpHeaders(id, s);
      break;
     case 1:
      s.write(Uint8Array.of(0x82, 0x02, 0, id), "binary")
      s.write("\x81\x11Welcome To Server", "binary")
      s.write("\x89\x08Welcome!", "binary");
      state = 2;
    case 2: // DETERMINE NEXT MESSAGE
      getNextState(id);
      break;
    case 3:
      msg = consumeMsgText(id);
      if (!yeld) { consumeDecodedMsg(msg, s); }
      break;
    case 4:
      consumeMsgPong(id);
      break;
    case 5:
      msg = consumeMsgBinary(id);
      if (!yeld) { consumeDecodedMsgBinary(msg, s); }
      break;
    case 88:
      msg = consumeMsgText(id);
      if (!yeld) { state = 99; } // Close connection so we're done.
      break;
    case 99:
      yeld = true;
    }
  }
  yeld = false;
}

function getNextState (id) {
  if (1 <= buffers.length) {
    switch (buffers[0]) {
    case 0x81 :
      state = 3; // Text
      break;
    case 0x82 :
      state = 5; // Binary
      break;
    case 0x8a :
      state = 4; // PONG
      break;
    case 0x88 :
      state = 88; // Closing
      break;
    default :
      state = 99;
      break;
    }
  } else {
    yeld = true;
  }
}

function writeStream (msg, s) {
  var len = msg.length;
  DB("<writeStream<" + msg);
  s.write("\x81" + String.fromCharCode(len) + msg, "binary");
}

function writeStreamBinary (msg, s) {
  var buff = Buffer.concat([Uint8Array.of(0x82, msg.byteLength), msg]);
  //DB("<sendbin<" + buff.length + " bytes."); // buff.map( (x) => x.toString(16)));
  s.write(buff, "binary");
}

function consumeDecodedMsgBinary (msg, s) {
  //DB("[bin-dec]" + msg.readUInt8(0) + " " + msg.readUInt8(1) + " " + msg.readFloatBE(2) + " " + msg.readFloatBE(6) + " " + msg.readFloatBE(10));
  writeStreamBinary(msg, s);
}

function consumeDecodedMsg (msg, s) {
  //var msgs = msg.split(' ')
  //if (msgs[0] == 'l') { writeStream(msgs[2] + " " + msgs[3] + " " + msgs[4], s); }
}

// Doesn't consume buffer until entire pong command is evaluated.
function consumeMsgText (id) {
  if (buffers.length < 2 ) { yeld = true; return; }

  var ml = buffers[1]
  var mask = ml & 0b10000000;
  var len  = ml & 0b01111111;
  if (125 < len) { state = 99; return; } // TODO Handle extended payload langths.

  if (buffers.length < (4 + len)) { yeld = true; return; }
  var mask = buffers.slice(2,6); // mask index and mask array
  var msg = buffers.slice(6,6+len).map((c,i,b)=>c^buffers[2+i%4]).toString();
  DB("[text]"+msg);
  global.msg=msg
  buffers = buffers.slice(6+len); // pop what we just consumed
  state = 2;
  return msg;
}

function consumeMsgBinary (id) {
  if (buffers.length < 2 ) { yeld = true; return; }

  var ml = buffers[1]
  var mask = ml & 0b10000000;
  var len  = ml & 0b01111111;
  if (125 < len) { state = 99; return; } // TODO Handle extended payload langths.

  if (buffers.length < (4 + len)) { yeld = true; return; }
  var mask = buffers.slice(2,6); // mask index and mask array
  var msg = buffers.slice(6,6+len).map((c,i,b)=>c^buffers[2+i%4])
  //DB("[bin]"+msg);
  buffers = buffers.slice(6+len); // pop what we just consumed
  state = 2;
  return msg;
}

// Doesn't consume buffer until entire pong command is evaluated.
function consumeMsgPong (id) {
  if (buffers.length < 2) { yeld = true; return; }

  var d = buffers[1]
  var mask = d & 0x80;
  var len = d & 0x7f;
  if (125 < len) { state = 99; return; } // TODO Handle extended payload lengths.

  if ( buffers.length < (4 + len)) { yeld = true; return; } // Full message not available yet.

  var mask = buffers.slice(2,6); // mask index and mask array
  DB("[pong]"+buffers.slice(6,6+len).map((c,i)=>c^buffers[2+i%4]).toString());
  buffers = buffers.slice(6+len); // pop what we just consumed
  state = 2;
};


function consumeHttpHeaders (id, s) {
  var next=0, from=0, to, p, header;
  while (true) {
    to = buffers.indexOf('\n', from); // Look for newline
    if (-1 == to) { yeld = true; break; } // Buffer incomplete, return later
    // Found full header
    next = to+1; // Next position to start scanning from next time around.
    if (13 == buffers[to-1]) { --to; } // Ignore newline and this possible return char when slicing the header.
    if (from == to) { // Empty line...done scanning httpHeaders.
      websocketSwitchProtocol(s);
      state = 1;
      break;
    }
    //header = buffers.slice(from,to); // Save header
    p = buffers.indexOf(' ', from);
    httpHeaders[buffers.slice(from,p).toString()] = buffers.slice(p+1,to).toString() ;
    from = next;
  }
  buffers = buffers.slice(next); // Throw away everything we've successfully scanner so far.
};


function websocketSwitchProtocol (s) {
  DB(httpHeaders);
  //global.httpHeaders = httpHeaders; // Debugging: For some reason var with "use strict" does not result in it being in TGE.
  var txt = httpHeaders['Sec-WebSocket-Key:'] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
  var dig = Crypto.createHash('sha1').update(txt).digest().toString('base64')
  s.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: "+dig+"\r\n\r\n", "binary");
};


////////////////////////////////////////////////////////////////////////////////
// REPL
////////////////////////////////////////////////////////////////////////////////
const Repl  = require('repl');
const qrepl = Repl.start({prompt:'REPL>', useGlobal:true, replMode:Repl.REPL_MODE_SLOPPY});
qrepl.on('exit', ()=>process.exit());


////////////////////////////////////////////////////////////////////////////////
// TODO
////////////////////////////////////////////////////////////////////////////////
/*******************************************************************************

# typeof
# Require
# Buffers
  Buffer.from("string").toString();

  Legacy type for networking support implementing JS.Uint8Array referencing an external static constant array.
# Scope: global vs top-level vs module local

       mode        assignment  global
       ----------  ----------  --------
       strict      x=9         ERROR
       strict      var x=9     x        (var x=8)       (let x=9 ERROR)
       strict      let x=9     -        (var x=8 ERROR) (let x=9 ERROR)

       -           x=9         x
       -           var x=9     x        (let x=9 ERROR)
       -           let x=9     -
       
  globals.x VS repl.repl.context.x
 
There is only one global (window in a browser).  Visible by all ~modules.
Node: moduels (files) contained in private closure
Browsers: everything WRT global (window)
let implies IIFE immediate invoked function expression


# USEFUL
 console.log(util.inspect(qrepl, {showHidden:true, depth:10, colors:1}))

# Float32Array
 a typed array 

*******************************************************************************/
