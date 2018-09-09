#!/usr/bin/node
"use strict";


////////////////////////////////////////////////////////////////////////////////
// Aliases
////////////////////////////////////////////////////////////////////////////////
const Util=require('util');
const Crypto=require('crypto');
const Log = process.stdout.write.bind(process.stdout); //console.log;
String.prototype.hex = function(){ return [...this].map(c=>("0"+c.charCodeAt().toString(16)).slice(-2)).join(); }
const red   ='\x1b[31m'
const yellow='\x1b[33m'
const off   ='\x1b[0m'



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
function server () {
  const Net=require('net');
  const qserver = Net.createServer(receiveConnection);
  qserver.listen(7199);
}


////////////////////////////////////////////////////////////////////////////////
// Agents
////////////////////////////////////////////////////////////////////////////////
function Agent (s, id) { // id socket
  this.id      = id;
  this.sock    = s;
  this.buffer  = Buffer(0);
  this.headers = {};
  this.state   = 0;
  this.yeld    = false;
}


////////////////////////////////////////////////////////////////////////////////
// Listener
////////////////////////////////////////////////////////////////////////////////
let connectionCount= 0;

function receiveConnection (sock) {
  sock.on('data', receiveBuffer.bind(new Agent(sock, ++connectionCount)));
  // TODO notify other clients new player.  Notify player of all current players.
};



////////////////////////////////////////////////////////////////////////////////
// State Machine
////////////////////////////////////////////////////////////////////////////////

function receiveBuffer (b) { // Buffer
  var agent = this; // Cheating
  var id = agent.id;
  var s = agent.sock;
  DB(`${red}[${id}]${util.inspect(b,{depth:1000})}${off}`);
  //DB(b.hex())
  agent.buffer = Buffer.concat([agent.buffer,b]);
  consume(agent);
}

function consume (a) { // agent
  var msg;
  while (!a.yeld) {
    DB(`${yellow}[${a.id}:${a.state}]${util.inspect(a.buffer)}${off}`);
    switch (a.state) {
    case 0: // READ HEADERS AND UPDATE WEBSOCKET PROTOCOL
      consumeHttpHeaders(a);
      break;
     case 1:
      a.sock.write(Uint8Array.of(0x82, 0x02, 0, a.id), "binary")
      a.sock.write("\x81\x11Welcome To Server", "binary")
      a.sock.write("\x89\x08Welcome!", "binary");
      a.state = 2;
    case 2: // DETERMINE NEXT MESSAGE
      getNextState(a);
      break;
    case 3:
      msg = consumeMsgText(a);
      if (!a.yeld) { consumeDecodedMsg(msg, a); }
      break;
    case 4:
      consumeMsgPong(a);
      break;
    case 5:
      msg = consumeMsgBinary(a);
      if (!a.yeld) { consumeDecodedMsgBinary(msg, a); }
      break;
    case 88:
      msg = consumeMsgText(a);
      if (!a.yeld) { a.state = 99; } // Close connection so we're done.
      break;
    case 99:
      a.yeld = true;
    }
  }
  a.yeld = false;
}

function getNextState (a) {
  if (1 <= a.buffer.length) {
    switch (a.buffer[0]) {
    case 0x81 :
      a.state = 3; // Text
      break;
    case 0x82 :
      a.state = 5; // Binary
      break;
    case 0x8a :
      a.state = 4; // PONG
      break;
    case 0x88 :
      a.state = 88; // Closing
      break;
    default :
      a.state = 99;
      break;
    }
  } else {
    a.yeld = true;
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

function consumeDecodedMsgBinary (msg, a) { // Buff Agent
  writeStreamBinary(msg, a.sock);
}

function consumeDecodedMsg (msg, a) {
  //var msgs = msg.split(' ')
  //if (msgs[0] == 'l') { writeStream(msgs[2] + " " + msgs[3] + " " + msgs[4], s); }
}

// Doesn't consume buffer until entire pong command is evaluated.
function consumeMsgText (a) {
  if (a.buffer.length < 2 ) { a.yeld = true; return; }

  var ml = a.buffer[1]
  var mask = ml & 0b10000000;
  var len  = ml & 0b01111111;
  if (125 < len) { a.state = 99; return; } // TODO Handle extended payload langths.

  if (a.buffer.length < (4 + len)) { a.yeld = true; return; }
  var mask = a.buffer.slice(2,6); // mask index and mask array
  var msg = a.buffer.slice(6,6+len).map((c,i,b)=>c^a.buffer[2+i%4]).toString();
  DB("[text]"+msg);
  a.buffer = a.buffer.slice(6+len); // pop what we just consumed
  a.state = 2;
  return msg;
}

function consumeMsgBinary (a) {
  if (a.buffer.length < 2 ) { a.yeld = true; return; }

  var ml = a.buffer[1]
  var mask = ml & 0b10000000;
  var len  = ml & 0b01111111;
  if (125 < len) { a.state = 99; return; } // TODO Handle extended payload langths.

  if (a.buffer.length < (4 + len)) { a.yeld = true; return; }
  var mask = a.buffer.slice(2,6); // mask index and mask array
  var msg = a.buffer.slice(6,6+len).map((c,i,b)=>c^a.buffer[2+i%4])
  //DB("[bin]"+msg);
  a.buffer = a.buffer.slice(6+len); // pop what we just consumed
  a.state = 2;
  return msg;
}

// Doesn't consume buffer until entire pong command is evaluated.
function consumeMsgPong (a) {
  if (a.buffer.length < 2) { a.yeld = true; return; }

  var d = a.buffer[1]
  var mask = d & 0x80;
  var len = d & 0x7f;
  if (125 < len) { a.state = 99; return; } // TODO Handle extended payload lengths.

  if ( a.buffer.length < (4 + len)) { a.yeld = true; return; } // Full message not available yet.

  var mask = a.buffer.slice(2,6); // mask index and mask array
  DB("[pong]"+a.buffer.slice(6,6+len).map((c,i)=>c^a.buffer[2+i%4]).toString());
  a.buffer = a.buffer.slice(6+len); // pop what we just consumed
  a.state = 2;
};


function consumeHttpHeaders (a) { // Agent
  var next=0, from=0, to, p, header;
  while (true) {
    to = a.buffer.indexOf('\n', from); // Look for newline
    if (-1 == to) { a.yeld = true; break; } // Buffer incomplete, return later
    // Found full header
    next = to+1; // Next position to start scanning from next time around.
    if (13 == a.buffer[to-1]) { --to; } // Ignore newline and this possible return char when slicing the header.
    if (from == to) { // Empty line...done scanning httpHeaders.
      websocketSwitchProtocol(a);
      a.state = 1;
      break;
    }
    //header = buffers.slice(from,to); // Save header
    p = a.buffer.indexOf(' ', from);
    a.headers[a.buffer.slice(from,p).toString()] = a.buffer.slice(p+1,to).toString() ;
    from = next;
  }
  a.buffer = a.buffer.slice(next); // Throw away everything we've successfully scanner so far.
};


function websocketSwitchProtocol (a) {
  DB(JSON.stringify(a.headers));
  //global.httpHeaders = httpHeaders; // Debugging: For some reason var with "use strict" does not result in it being in TGE.
  var txt = a.headers['Sec-WebSocket-Key:'] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
  var dig = Crypto.createHash('sha1').update(txt).digest().toString('base64')
  a.sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: "+dig+"\r\n\r\n", "binary");
};

//////////////
// fun
/////////////
var d = Date.now();
var b = 0;
var a = Float64Array.from([1.1,2.1,3.1,4.1,5.1,6.1,7.1,8.1,9.1,10.1]);
//for (var i=0; i<65536*16384; i++) b += a[0] + a[1] + a[2] + a[3] + a[4] + a[5] + a[6] + a[7] + a[8] + a[9];
//for (var i=0; i<65536*16384; i++) b+=  a[i];
//console.log(Date.now() - d + " " + b);



////////////////////////////////////////////////////////////////////////////////
// REPL
////////////////////////////////////////////////////////////////////////////////
const Repl  = require('repl');
const qrepl = Repl.start({prompt:'REPL>', useGlobal:true, replMode:Repl.REPL_MODE_SLOPPY});
qrepl.on('exit', ()=>process.exit());

server();

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

# String.prototype.hex = function(){ return [...this].map(c=> ("0"+c.charCodeAt().toString(16)).slice(-2)).join(); }
# String.fromCharCode(...[65,66,67])
# Buffer("\uffff").toString().split('').map( c=>c.charCodeAt() )


*******************************************************************************/
